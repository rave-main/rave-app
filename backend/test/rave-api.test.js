const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, signedInAgent, request } = require('./helpers');

let pool, app;
before(async () => ({ pool, app } = await setup()));
after(() => pool.end());

const insertRun = async (status, ago = '0 minutes', extra = {}) =>
  (await pool.query(
    `INSERT INTO collection_runs (kind, status, started_at, finished_at, pages_fetched, pages_total, tickers_seen, rows_written, market_total_mentions, error)
     VALUES ('apewisdom', $1, now() - $2::interval, now() - $2::interval, 2, 2, 150, 102, 5000, $3) RETURNING *`,
    [status, ago, extra.error ?? null]
  )).rows[0];

test('RAVE endpoints require sign-in', async () => {
  await request(app).get('/api/rave/status').expect(401);
  await request(app).get('/api/rave/stocks').expect(401);
  await request(app).get('/api/rave/watchlist').expect(401);
});

test('watchlist is seeded with the starting stocks and two controls', async () => {
  const { agent } = await signedInAgent(app);
  const { body } = await agent.get('/api/rave/watchlist').expect(200);
  assert.equal(body.length, 10);
  assert.deepEqual(body.filter((w) => w.isControl).map((w) => w.ticker), ['AAPL', 'MSFT']);
  assert.ok(body.some((w) => w.ticker === 'GME' && w.name === 'GameStop'));
});

test('status reports stale with no data, then fresh after a recent run, then stale again when old', async () => {
  await pool.query('TRUNCATE collection_runs, snapshots RESTART IDENTITY CASCADE');
  const { agent } = await signedInAgent(app);

  let { body } = await agent.get('/api/rave/status').expect(200);
  assert.equal(body.stale, true);
  assert.equal(body.lastSuccess, null);

  await insertRun('success', '10 minutes');
  ({ body } = await agent.get('/api/rave/status').expect(200));
  assert.equal(body.stale, false);
  assert.equal(body.lastSuccess.rowsWritten, 102);
  assert.equal(body.last24h.success, 1);

  await pool.query('TRUNCATE collection_runs RESTART IDENTITY CASCADE');
  await insertRun('success', '3 hours');
  await insertRun('failed', '5 minutes', { error: 'upstream down' });
  ({ body } = await agent.get('/api/rave/status').expect(200));
  assert.equal(body.stale, true);
  assert.equal(body.lastRun.status, 'failed');
  assert.equal(body.lastRun.error, 'upstream down');
  assert.equal(body.last24h.failed, 1);
});

test('stocks returns the latest snapshot per watchlist stock, and nulls where none exists yet', async () => {
  await pool.query('TRUNCATE collection_runs, snapshots RESTART IDENTITY CASCADE');
  const { agent } = await signedInAgent(app);
  const run = await insertRun('success');
  const add = (ticker, at, mentions, ranked = true) =>
    pool.query(
      `INSERT INTO snapshots (run_id, ticker, fetched_at, ranked, rank, mentions) VALUES ($1, $2, now() - $3::interval, $4, $5, $6)`,
      [run.id, ticker, at, ranked, ranked ? 3 : null, mentions]
    );
  await add('GME', '2 hours', 10);
  await add('GME', '10 minutes', 99);
  await add('AMC', '10 minutes', 0, false);

  const { body } = await agent.get('/api/rave/stocks').expect(200);
  const byTicker = Object.fromEntries(body.map((s) => [s.ticker, s]));
  assert.equal(body.length, 10);
  assert.equal(byTicker.GME.mentions, 99, 'uses the newest snapshot');
  assert.equal(byTicker.AMC.ranked, false);
  assert.equal(byTicker.TSLA.mentions, null, 'no snapshot yet');
});

test('stocks include scores computed from stored history, and "No data" for stocks without any', async () => {
  const { simulate, HOUR } = require('./rave-sim');
  await pool.query('TRUNCATE collection_runs, snapshots RESTART IDENTITY CASCADE');
  const { agent } = await signedInAgent(app);

  // 40 days of GME history, shifted so the newest point is "now"; a 5x surge over the final 36 hours
  const base = simulate({ days: 40, seed: 21, multiplier: () => 1 });
  const surge = simulate({ days: 40, seed: 21, multiplier: (t) => (t > base[base.length - 1].t - 36 * HOUR ? 5 : 1) });
  const shift = Date.now() - surge[surge.length - 1].t;
  const times = surge.map((p) => new Date(p.t + shift));
  const { rows: runs } = await pool.query(
    `INSERT INTO collection_runs (kind, status, started_at, market_total_mentions)
     SELECT 'apewisdom', 'success', t, m FROM unnest($1::timestamptz[], $2::int[]) AS x(t, m) RETURNING id`,
    [times, surge.map((p) => p.market)]
  );
  await pool.query(
    `INSERT INTO snapshots (run_id, ticker, fetched_at, ranked, rank, mentions)
     SELECT run_id, 'GME', t, true, 3, m FROM unnest($1::int[], $2::timestamptz[], $3::int[]) AS x(run_id, t, m)`,
    [runs.map((r) => r.id), times, surge.map((p) => p.mentions)]
  );

  const { body } = await agent.get('/api/rave/stocks').expect(200);
  const byTicker = Object.fromEntries(body.map((s) => [s.ticker, s]));
  assert.equal(byTicker.GME.scores.version, 'v1');
  assert.equal(byTicker.GME.scores.short.status, 'ok');
  assert.ok(['Hot', 'Extreme'].includes(byTicker.GME.scores.short.label), byTicker.GME.scores.short.label);
  assert.match(byTicker.GME.scores.short.explanation, /^GME: /);
  assert.equal(byTicker.GME.scores.medium.status, 'ok');
  assert.equal(byTicker.TSLA.scores.summary.label, 'No data');
});

// Inserts a successful run `minutesAgo` minutes ago with the given mentions per ticker
async function addRun(minutesAgo, mentions, { market = 1000, status = 'success' } = {}) {
  const { rows: [run] } = await pool.query(
    `INSERT INTO collection_runs (kind, status, started_at, finished_at, pages_fetched, pages_total, tickers_seen, rows_written, market_total_mentions)
     VALUES ('apewisdom', $1, now() - make_interval(mins => $2), now() - make_interval(mins => $2) + interval '8 seconds', 9, 9, 800, 103, $3)
     RETURNING id`,
    [status, minutesAgo, market]
  );
  if (status === 'success') {
    for (const [ticker, m] of Object.entries(mentions)) {
      await pool.query(
        `INSERT INTO snapshots (run_id, ticker, fetched_at, ranked, rank, mentions, mentions_24h_ago)
         VALUES ($1, $2, now() - make_interval(mins => $3), true, 5, $4, 10)`,
        [run.id, ticker, minutesAgo, m]
      );
    }
  }
  return run;
}

test('status and runs tell "checked" apart from "data actually changed"', async () => {
  await pool.query('TRUNCATE collection_runs, snapshots RESTART IDENTITY CASCADE');
  const { agent } = await signedInAgent(app);

  await addRun(150, { GME: 5, AMC: 2 });
  await addRun(120, { GME: 5, AMC: 2 }); // identical to the run before
  await addRun(90, { GME: 5, AMC: 2 }); // identical again
  let { body } = await agent.get('/api/rave/status').expect(200);
  assert.equal(body.lastChangeAt, null, 'no change has been seen yet');
  assert.equal(body.unchangedRuns, 3);
  assert.equal(body.expectedIntervalMinutes, 30);

  await addRun(60, { GME: 9, AMC: 2 }); // GME moved
  await addRun(30, { GME: 9, AMC: 2 });
  ({ body } = await agent.get('/api/rave/status').expect(200));
  assert.ok(body.lastChangeAt, 'a change is now on record');
  assert.ok(Math.abs((Date.now() - new Date(body.lastChangeAt).getTime()) / 60000 - 60) < 2, 'the change was 60 minutes ago');
  assert.equal(body.unchangedRuns, 1, 'one successful run since the change');

  const { body: runs } = await agent.get('/api/rave/runs?limit=10').expect(200);
  assert.equal(runs.length, 5);
  assert.deepEqual(runs.map((r) => r.changed), [false, true, false, false, null], 'newest first; the oldest has nothing to compare with');
  assert.equal(Math.round(runs[0].durationSec), 8);
  assert.equal(runs[0].tickersSeen, 800);
});

test('runs lists failures and never marks them as a data change', async () => {
  await pool.query('TRUNCATE collection_runs, snapshots RESTART IDENTITY CASCADE');
  const { agent } = await signedInAgent(app);
  await addRun(90, { GME: 5 });
  await addRun(60, {}, { status: 'failed' });
  await addRun(30, { GME: 6 });
  const { body: runs } = await agent.get('/api/rave/runs').expect(200);
  assert.deepEqual(runs.map((r) => [r.status, r.changed]), [['success', true], ['failed', null], ['success', null]]);
});

test('stocks include a sparkline and the day-over-day comparison', async () => {
  await pool.query('TRUNCATE collection_runs, snapshots RESTART IDENTITY CASCADE');
  const { agent } = await signedInAgent(app);
  for (let i = 5; i >= 1; i--) await addRun(i * 30, { GME: 10 + (5 - i) });
  const { body } = await agent.get('/api/rave/stocks').expect(200);
  const gme = body.find((s) => s.ticker === 'GME');
  assert.deepEqual(gme.spark, [10, 11, 12, 13, 14]);
  assert.equal(gme.dayOverDay.change, 4); // 14 now vs the 10 stored as "24h ago"
  assert.equal(body.find((s) => s.ticker === 'TSLA').dayOverDay, null);
  assert.deepEqual(body.find((s) => s.ticker === 'TSLA').spark, []);
});

test('single-stock endpoint returns history, scores and 404s for unknown tickers', async () => {
  await pool.query('TRUNCATE collection_runs, snapshots RESTART IDENTITY CASCADE');
  const { agent } = await signedInAgent(app);
  for (let i = 4; i >= 1; i--) await addRun(i * 45, { GME: 10 * i }); // 45, 90, 135 and 180 minutes ago
  const { body } = await agent.get('/api/rave/stocks/gme?hours=2').expect(200);
  assert.equal(body.ticker, 'GME');
  assert.equal(body.name, 'GameStop');
  assert.equal(body.history.length, 2, 'hours=2 keeps the 45- and 90-minute-old points only');
  assert.equal(body.latest.mentions, 10);
  assert.equal(body.scores.short.status, 'warming_up');
  const all = (await agent.get('/api/rave/stocks/GME').expect(200)).body;
  assert.equal(all.history.length, 4);
  await agent.get('/api/rave/stocks/NOPE').expect(404);
  await request(app).get('/api/rave/runs').expect(401);
});
