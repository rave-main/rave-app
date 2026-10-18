const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, signedInAgent } = require('./helpers');
const { runCollection } = require('../src/rave/collector');
const { auditRuns } = require('../src/rave/audit');

let pool, app;
before(async () => ({ pool, app } = await setup()));
after(() => pool.end());

function leaderboard(bump = 0) {
  const rows = Array.from({ length: 150 }, (_, i) => ({
    ticker: `T${i + 1}`, name: `Company ${i + 1}`, rank: i + 1, mentions: 500 - i * 3 + (i === 4 ? bump : 0), upvotes: 5, rank24hAgo: i + 1, mentions24hAgo: 400 - i * 3,
  }));
  rows[2].ticker = 'GME';
  rows[119].ticker = 'AAPL';
  const payload = (slice) => ({ count: 150, pages: 2, results: slice.map((r) => ({ rank: r.rank, ticker: r.ticker, name: r.name, mentions: String(r.mentions), upvotes: r.upvotes })) });
  return { filter: 'all-stocks', totalPages: 2, truncated: false, rows, rawPages: [{ page: 1, payload: payload(rows.slice(0, 100)) }, { page: 2, payload: payload(rows.slice(100)) }] };
}
const collect = async (n) => {
  await pool.query('TRUNCATE collection_runs, raw_snapshots, snapshots RESTART IDENTITY CASCADE');
  for (let i = 0; i < n; i++) assert.equal((await runCollection(pool, { fetchLeaderboard: async () => leaderboard(i), minIntervalMs: 0 })).status, 'success');
};
const failing = (audit) => audit.checks.filter((c) => !c.ok).map((c) => c.id);

test('a normal series of runs passes every check', async () => {
  await collect(3);
  const audit = await auditRuns(pool);
  assert.equal(audit.runsChecked, 3);
  assert.equal(audit.runsWithRawData, 3);
  assert.deepEqual(failing(audit), []);
  assert.equal(audit.ok, true);
  assert.equal(audit.checks.length, 6);
  assert.equal(audit.note, null);
});

test('detects a stored value that differs from the raw response', async () => {
  await collect(2);
  await pool.query(`UPDATE snapshots SET mentions = mentions + 1 WHERE ticker = 'GME' AND run_id = 1`);
  const audit = await auditRuns(pool);
  assert.deepEqual(failing(audit), ['values-match']);
  assert.match(audit.checks.find((c) => c.id === 'values-match').problems[0], /1 stored row\(s\) differ/);
});

test('detects a missing row, a wrong total and a missing watchlist stock', async () => {
  await collect(2);
  await pool.query(`DELETE FROM snapshots WHERE ticker = 'T7' AND run_id = 1`);
  await pool.query(`UPDATE collection_runs SET market_total_mentions = market_total_mentions + 5 WHERE id = 2`);
  await pool.query(`DELETE FROM snapshots WHERE ticker = 'MSFT' AND run_id = 2`);
  const audit = await auditRuns(pool);
  assert.deepEqual(failing(audit).sort(), ['market-total', 'rows-saved', 'watchlist-complete']);
});

test('detects raw data that is missing pages, and a stored row for a stock the raw data does not have', async () => {
  await collect(2);
  await pool.query(`DELETE FROM raw_snapshots WHERE run_id = 1 AND page = 2`);
  await pool.query(`UPDATE snapshots SET ranked = false, rank = NULL, mentions = 0 WHERE ticker = 'GME' AND run_id = 2`);
  const audit = await auditRuns(pool);
  assert.ok(failing(audit).includes('raw-pages'));
  assert.ok(failing(audit).includes('raw-tickers'));
  assert.ok(failing(audit).includes('values-match'), 'a row marked unranked although the raw data lists it');
});

test('reports gaps in collection and tolerates runs whose raw data has expired', async () => {
  await collect(3);
  await pool.query(`UPDATE collection_runs SET started_at = now() - interval '4 hours 10 minutes' WHERE id = 1`);
  await pool.query(`UPDATE collection_runs SET started_at = now() - interval '4 hours' WHERE id = 2`);
  await pool.query(`DELETE FROM raw_snapshots WHERE run_id = 1`); // as if past retention
  const audit = await auditRuns(pool);
  assert.equal(audit.runsWithRawData, 2);
  assert.match(audit.note, /1 older run/);
  assert.equal(audit.cadence.gapsOver45Min, 1, 'the gap from 4 hours ago to now');
  assert.ok(audit.cadence.longestGapMinutes >= 239);
  assert.deepEqual(failing(audit), [], 'expired raw data is not an error');
});

test('integrity endpoint requires sign-in and returns the audit', async () => {
  await collect(2);
  const { agent } = await signedInAgent(app);
  const res = await agent.get('/api/rave/integrity?runs=10').expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.runsChecked, 2);
  await require('supertest')(app).get('/api/rave/integrity').expect(401);
});
