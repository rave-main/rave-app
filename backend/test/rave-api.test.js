const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, signedInAgent, request, resetRave, seedHistory } = require('./helpers');
const { simulate, simulateCounts, HOUR } = require('./rave-sim');

let pool, app;
before(async () => ({ pool, app } = await setup()));
after(() => pool.end());

const insertRun = async (status, ago = '0 minutes', { error = null, fp = null } = {}) =>
  (await pool.query(
    `INSERT INTO collection_runs (kind, status, started_at, finished_at, pages_fetched, pages_total, tickers_seen, rows_written, market_total_mentions, error, details)
     VALUES ('apewisdom', $1, now() - $2::interval, now() - $2::interval + interval '8 seconds', 9, 9, 800, 800, 5000, $3, $4) RETURNING *`,
    [status, ago, error, fp ? JSON.stringify({ fp }) : null]
  )).rows[0];

test('RAVE endpoints require sign-in', async () => {
  for (const path of ['status', 'stocks', 'stocks/GME', 'watchlist', 'runs', 'sources', 'integrity']) {
    await request(app).get(`/api/rave/${path}`).expect(401);
  }
});

test('watchlist is seeded with the starting stocks and two controls', async () => {
  const { agent } = await signedInAgent(app);
  const { body } = await agent.get('/api/rave/watchlist').expect(200);
  assert.equal(body.length, 10);
  assert.deepEqual(body.filter((w) => w.isControl).map((w) => w.ticker), ['AAPL', 'MSFT']);
});

test('status reports stale with no data, fresh after a recent run, stale again when old, and the database size', async () => {
  await resetRave(pool);
  const { agent } = await signedInAgent(app);
  let { body } = await agent.get('/api/rave/status').expect(200);
  assert.equal(body.stale, true);
  assert.equal(body.lastSuccess, null);
  assert.equal(body.expectedIntervalMinutes, 30);
  assert.ok(body.database.sizeMB > 0 && body.database.limitMB === 500 && body.database.usedPercent >= 0);

  await insertRun('success', '10 minutes');
  ({ body } = await agent.get('/api/rave/status').expect(200));
  assert.equal(body.stale, false);
  assert.equal(body.last24h.success, 1);

  await resetRave(pool);
  await insertRun('success', '3 hours');
  await insertRun('failed', '5 minutes', { error: 'upstream down' });
  ({ body } = await agent.get('/api/rave/status').expect(200));
  assert.equal(body.stale, true);
  assert.equal(body.lastRun.status, 'failed');
  assert.equal(body.lastRun.error, 'upstream down');
  assert.equal(body.last24h.failed, 1);
});

test('status and runs tell "checked" apart from "data actually changed" (using each run\'s fingerprint)', async () => {
  await resetRave(pool);
  const { agent } = await signedInAgent(app);
  await insertRun('success', '150 minutes', { fp: 'aaa' });
  await insertRun('success', '120 minutes', { fp: 'aaa' });
  await insertRun('success', '90 minutes', { fp: 'aaa' });
  let { body } = await agent.get('/api/rave/status').expect(200);
  assert.equal(body.lastChangeAt, null, 'no change has been seen yet');
  assert.equal(body.unchangedRuns, 3);

  await insertRun('failed', '75 minutes', { error: 'blip' });
  await insertRun('success', '60 minutes', { fp: 'bbb' }); // the numbers moved (a failed run in between must not hide it)
  await insertRun('success', '30 minutes', { fp: 'bbb' });
  ({ body } = await agent.get('/api/rave/status').expect(200));
  assert.ok(Math.abs((Date.now() - new Date(body.lastChangeAt).getTime()) / 60000 - 60) < 2, 'the change was 60 minutes ago');
  assert.equal(body.unchangedRuns, 1);

  const { body: runs } = await agent.get('/api/rave/runs?limit=10').expect(200);
  assert.equal(runs.length, 6);
  assert.deepEqual(runs.map((r) => r.changed), [false, true, null, false, false, null], 'newest first; failed and first runs have nothing to compare');
  assert.equal(Math.round(runs[0].durationSec), 8);
});

test('stocks: every watchlist stock plus any ticker that reached 5 mentions lately, with scores, a sparkline and day-over-day', async () => {
  await resetRave(pool);
  const { agent } = await signedInAgent(app);
  const grid = simulate({ days: 40, seed: 21 }); // 40 days, one point per 30 minutes
  const surge = simulate({ days: 40, seed: 21, multiplier: (t) => (t > grid[grid.length - 1].t - 36 * HOUR ? 5 : 1) });
  const flat = (level) => grid.map((p) => ({ ...p, mentions: level }));
  await seedHistory(pool, { GME: surge, HOT1: flat(30), QUIET1: flat(2) });

  const { body } = await agent.get('/api/rave/stocks').expect(200);
  const by = Object.fromEntries(body.map((s) => [s.ticker, s]));
  assert.ok(by.GME && by.TSLA, 'watchlist stocks are always included');
  assert.ok(by.HOT1, 'a non-watchlist ticker at 30 mentions a day is tracked');
  assert.equal(by.QUIET1, undefined, 'a ticker that never reaches 5 mentions is stored but not tracked');
  assert.equal(by.HOT1.isWatchlist, false);
  assert.equal(by.GME.isWatchlist, true);
  assert.equal(body.length, 11);

  assert.equal(by.GME.scores.version, 'v1');
  assert.equal(by.GME.scores.short.status, 'ok');
  assert.ok(['Hot', 'Extreme'].includes(by.GME.scores.short.label), by.GME.scores.short.label);
  assert.match(by.GME.scores.short.explanation, /^GME: /);
  assert.equal(by.GME.scores.medium.status, 'ok');
  assert.equal(by.TSLA.scores.summary.label, 'Low volume', 'a watchlist stock that was never on the leaderboard has 0 mentions: too few to rate');
  assert.equal(by.HOT1.spark.length, 48);
  assert.equal(by.HOT1.dayOverDay.change, 3, 'latest 30 vs the stored 24h-ago value of 27');
  assert.deepEqual(by.TSLA.spark, Array(48).fill(0));
});

test('single-stock endpoint works for any ticker that has been on the leaderboard, with history, and 404s otherwise', async () => {
  await resetRave(pool);
  const { agent } = await signedInAgent(app);
  const grid = simulateCounts({ days: 3, level: 20, seed: 4 });
  await seedHistory(pool, { ZZZ: grid });
  const day = await agent.get('/api/rave/stocks/zzz?hours=24').expect(200);
  assert.equal(day.body.ticker, 'ZZZ');
  assert.equal(day.body.isWatchlist, false);
  assert.ok(day.body.history.length >= 47 && day.body.history.length <= 49, `${day.body.history.length} points in 24h`);
  assert.equal(day.body.latest.mentions, grid[grid.length - 1].mentions);
  assert.equal(day.body.scores.short.status, 'warming_up');
  const gme = await agent.get('/api/rave/stocks/GME').expect(200);
  assert.equal(gme.body.name, 'GameStop');
  assert.equal(gme.body.isWatchlist, true);
  await agent.get('/api/rave/stocks/NOPE').expect(404);
});

test('status history comes from the day arrays', async () => {
  await resetRave(pool);
  const { agent } = await signedInAgent(app);
  await seedHistory(pool, { ZZZ: simulateCounts({ days: 3, level: 10, seed: 5 }) });
  const { body } = await agent.get('/api/rave/status').expect(200);
  assert.ok(body.history.snapshots > 90, `${body.history.snapshots} readings`);
  assert.ok(new Date(body.history.firstSnapshotAt).getTime() < Date.now() - 24 * 3600000);
});
