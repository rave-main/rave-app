const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, signedInAgent, request, resetRave } = require('./helpers');
const { runCollection } = require('../src/rave/collector');
const { auditRuns } = require('../src/rave/audit');
const { slotOf } = require('../src/rave/store');

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
// n runs, 30 minutes apart, the newest about 10 minutes ago, each in its own half-hour slot
const collect = async (n) => {
  await resetRave(pool);
  const newest = Date.now() - 10 * 60000;
  for (let i = 0; i < n; i++) {
    const at = new Date(Math.floor((newest - (n - 1 - i) * 30 * 60000) / (30 * 60000)) * 30 * 60000 + 2 * 60000);
    assert.equal((await runCollection(pool, { fetchLeaderboard: async () => leaderboard(i), at })).status, 'success');
  }
};
const failing = (audit) => audit.checks.filter((c) => !c.ok).map((c) => c.id);
const slotOfRun = async (id) => {
  const { rows: [r] } = await pool.query('SELECT started_at FROM collection_runs WHERE id = $1', [id]);
  return slotOf(r.started_at);
};

test('a normal series of runs passes every check', async () => {
  await collect(3);
  const audit = await auditRuns(pool);
  assert.equal(audit.runsChecked, 3);
  assert.equal(audit.runsWithRawData, 3);
  assert.deepEqual(failing(audit), []);
  assert.equal(audit.ok, true);
  assert.equal(audit.checks.length, 5);
  assert.equal(audit.cadence.gapsOver45Min, 0);
  assert.equal(audit.note, null);
});

test('detects a stored value that differs from the raw response', async () => {
  await collect(2);
  const { day, slot } = await slotOfRun(1);
  await pool.query(`UPDATE ticker_days SET mentions[$3] = mentions[$3] + 1 WHERE ticker = 'GME' AND day = $1 AND $2 = $2`, [day, slot, slot + 1]);
  const audit = await auditRuns(pool);
  assert.deepEqual(failing(audit), ['values-match']);
  assert.match(audit.checks.find((c) => c.id === 'values-match').problems[0], /1 stored value\(s\) differ/);
});

test('detects a missing ticker, a wrong total and a phantom ticker', async () => {
  await collect(2);
  const a = await slotOfRun(1);
  const b = await slotOfRun(2);
  await pool.query(`DELETE FROM ticker_days WHERE ticker = 'T7' AND day = $1`, [a.day]); // a listed ticker lost
  await pool.query(`UPDATE market_days SET market[$2] = market[$2] + 5 WHERE day = $1`, [b.day, b.slot + 1]); // total no longer matches
  const audit = await auditRuns(pool);
  assert.deepEqual(failing(audit).sort(), ['market-total', 'rows-saved', 'values-match']);
  await collect(1);
  const c = await slotOfRun(1);
  await pool.query(
    `INSERT INTO ticker_days (ticker, day, mentions, ranks) VALUES ('PHANTOM', $1, array_fill(1, ARRAY[48]), array_fill(9::smallint, ARRAY[48]))`, [c.day]
  );
  assert.ok(failing(await auditRuns(pool)).includes('values-match'), 'a stored ranked row the raw data does not have');
});

test('detects raw data that is missing pages', async () => {
  await collect(2);
  await pool.query(`DELETE FROM raw_snapshots WHERE run_id = 1 AND page = 2`);
  const audit = await auditRuns(pool);
  assert.ok(failing(audit).includes('raw-pages'));
  assert.ok(failing(audit).includes('raw-tickers'));
});

test('reports gaps in collection and tolerates runs whose raw data has expired', async () => {
  await collect(3);
  await pool.query(`UPDATE collection_runs SET started_at = started_at - interval '4 hours' WHERE id IN (1, 2)`);
  await pool.query(`DELETE FROM raw_snapshots WHERE run_id = 1`); // as if past retention
  const audit = await auditRuns(pool);
  assert.equal(audit.runsWithRawData, audit.runsChecked - 1);
  assert.match(audit.note, /1 older run/);
  assert.equal(audit.cadence.gapsOver45Min, 1, 'the gap between the older pair and the newest run');
  assert.ok(audit.cadence.longestGapMinutes >= 200);
});

test('a run overwritten by a later run in the same half hour is superseded, not reported as an error', async () => {
  await resetRave(pool);
  const slotStart = Math.floor((Date.now() - 3 * 3600000) / (30 * 60000)) * 30 * 60000;
  await runCollection(pool, { fetchLeaderboard: async () => leaderboard(0), at: new Date(slotStart + 60000) });
  await runCollection(pool, { fetchLeaderboard: async () => leaderboard(9), at: new Date(slotStart + 600000) }); // same slot, different numbers
  const audit = await auditRuns(pool);
  assert.equal(audit.runsChecked, 1, 'only the run whose values are stored is checked');
  assert.equal(audit.ok, true);
});

test('integrity endpoint requires sign-in and returns the audit', async () => {
  await collect(2);
  const { agent } = await signedInAgent(app);
  const res = await agent.get('/api/rave/integrity?runs=10').expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.runsChecked, 2);
  await request(app).get('/api/rave/integrity').expect(401);
});

test('runs from before the storage migration are skipped with an explanation, but still count for cadence', async () => {
  await collect(2);
  await pool.query(`INSERT INTO collection_runs (kind, status, started_at, tickers_seen, rows_written, market_total_mentions, details)
                    VALUES ('apewisdom', 'success', now() - interval '5 hours', 800, 103, 4000, '{"legacy": true}')`);
  const audit = await auditRuns(pool);
  assert.equal(audit.runsChecked, 2, 'the legacy run is not checked');
  assert.equal(audit.ok, true);
  assert.match(audit.note, /1 early run\(s\) were stored in an earlier layout/);
  assert.equal(audit.cadence.gapsOver45Min, 1, 'but its absence from the cadence is visible');
});

test('a ticker listed on two pages is checked against the first listing, as the collector stores it', async () => {
  await resetRave(pool);
  const lb = leaderboard();
  const dup = { rank: 120, ticker: 'GME', name: 'GameStop', mentions: '7', upvotes: 1 };
  lb.rawPages[1].payload.results.push(dup);
  const at = new Date(Math.floor((Date.now() - 10 * 60000) / (30 * 60000)) * 30 * 60000 + 2 * 60000);
  assert.equal((await runCollection(pool, { fetchLeaderboard: async () => lb, at })).status, 'success');
  const audit = await auditRuns(pool);
  assert.deepEqual(failing(audit), []);
});
