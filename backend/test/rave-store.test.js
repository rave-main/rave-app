const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, resetRave } = require('./helpers');
const { runCollection } = require('../src/rave/collector');
const { slotOf, pointTime } = require('../src/rave/store');

let pool;
before(async () => ({ pool } = await setup()));
after(() => pool.end());

// A leaderboard of 150 tickers: GME is #3, AAPL #120; the rest of the watchlist is absent
function leaderboard({ drop = [], extra = [], bump = {} } = {}) {
  let rows = Array.from({ length: 150 }, (_, i) => ({
    ticker: `T${i + 1}`, name: `Company ${i + 1}`, rank: i + 1, mentions: 1000 - i * 5, upvotes: 50, rank24hAgo: i + 2, mentions24hAgo: 900 - i * 5,
  }));
  rows[2].ticker = 'GME';
  rows[119].ticker = 'AAPL';
  rows = rows.filter((r) => !drop.includes(r.ticker)).concat(extra).map((r) => ({ ...r, mentions: r.mentions + (bump[r.ticker] || 0) }));
  rows.forEach((r, i) => (r.rank = i + 1));
  const page = (slice) => ({ count: rows.length, pages: 2, results: slice });
  return { filter: 'all-stocks', totalPages: 2, truncated: false, rows, rawPages: [{ page: 1, payload: page(rows.slice(0, 100)) }, { page: 2, payload: page(rows.slice(100)) }] };
}
const fake = (lb = leaderboard()) => async () => lb;
// Two days ago at 10:05 UTC (slot 20). Recent, because raw responses older than 7 days are pruned immediately.
const T0 = new Date(Math.floor(Date.now() / 86400000) * 86400000 - 2 * 86400000 + 10 * 3600000 + 5 * 60000);
const DAY0 = slotOf(T0).day;
const DAY1 = slotOf(new Date(T0.getTime() + 14 * 3600000)).day; // the next UTC day
const at = (minutes) => new Date(T0.getTime() + minutes * 60000);
const cell = async (ticker, day, slot, col = 'mentions') =>
  (await pool.query(`SELECT ${col}[$3] AS v FROM ticker_days WHERE ticker = $1 AND day = $2`, [ticker, day, slot + 1])).rows[0]?.v;

test('slotOf maps a time to its UTC day and half-hour slot', () => {
  assert.deepEqual({ day: slotOf('2026-10-10T00:00:00Z').day, slot: slotOf('2026-10-10T00:00:00Z').slot }, { day: '2026-10-10', slot: 0 });
  assert.equal(slotOf('2026-10-10T00:29:59Z').slot, 0);
  assert.equal(slotOf('2026-10-10T00:30:00Z').slot, 1);
  assert.equal(slotOf('2026-10-10T17:32:10Z').slot, 35);
  assert.equal(slotOf('2026-10-10T23:59:59Z').slot, 47);
  assert.equal(slotOf('2026-10-11T00:00:01Z').day, '2026-10-11');
  assert.equal(pointTime('2026-10-10', 35), Date.parse('2026-10-10T17:30:00Z'));
});

test('a run stores EVERY ticker compactly, the market total, names, raw pages and a fingerprint', async () => {
  await resetRave(pool);
  const result = await runCollection(pool, { fetchLeaderboard: fake(), at: at(0) });
  assert.equal(result.status, 'success');

  const { rows: [run] } = await pool.query('SELECT * FROM collection_runs');
  assert.equal(run.tickers_seen, 150);
  assert.equal(run.rows_written, 150);
  assert.equal(run.market_total_mentions, leaderboard().rows.reduce((s, r) => s + r.mentions, 0));
  assert.match(run.details.fp, /^[0-9a-f]{32}$/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM raw_snapshots')).rows[0].n, 2);

  assert.equal(await cell('GME', DAY0, 20), 990);
  assert.equal(await cell('GME', DAY0, 20, 'ranks'), 3);
  assert.equal(await cell('T130', DAY0, 20), 1000 - 129 * 5, 'a ticker far down the leaderboard is stored too');
  assert.equal(await cell('GME', DAY0, 21), null, 'slots with no run stay NULL');
  assert.equal(await cell('AMC', DAY0, 20), 0, 'a watchlist stock missing from the leaderboard is stored as 0');
  assert.equal(await cell('AMC', DAY0, 20, 'ranks'), null);

  const { rows: [md] } = await pool.query(`SELECT market[21] AS m, tickers[21] AS t FROM market_days WHERE day = '${DAY0}'`);
  assert.equal(md.m, run.market_total_mentions);
  assert.equal(md.t, 150);

  const { rows: [gme] } = await pool.query(`SELECT * FROM tickers WHERE ticker = 'GME'`);
  assert.deepEqual([gme.name, gme.ranked, gme.rank, gme.mentions, gme.rank_24h_ago, gme.mentions_24h_ago], ['Company 3', true, 3, 990, 4, 890]);
  const { rows: [amc] } = await pool.query(`SELECT * FROM tickers WHERE ticker = 'AMC'`);
  assert.deepEqual([amc.name, amc.ranked, amc.mentions], ['AMC Entertainment', false, 0]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tickers')).rows[0].n, 150 + 8, 'every ticker plus the watchlist stocks that were absent');
});

test('later runs fill their own slot; absent tickers become 0; new tickers are back-filled with zeros', async () => {
  await resetRave(pool);
  await runCollection(pool, { fetchLeaderboard: fake(), at: at(0) }); // slot 20
  await runCollection(pool, { fetchLeaderboard: fake(leaderboard({ drop: ['T50'], extra: [{ ticker: 'NEWB', name: 'Newbie', mentions: 77, upvotes: 1, rank24hAgo: null, mentions24hAgo: null }], bump: { GME: 10 } })), at: at(60) }); // slot 22
  const day = DAY0;
  assert.equal(await cell('GME', day, 20), 990);
  assert.equal(await cell('GME', day, 22), 1000, 'the new reading landed in slot 22');
  assert.equal(await cell('GME', day, 21), null, 'the skipped slot has no reading');
  assert.equal(await cell('T50', day, 20), 1000 - 49 * 5);
  assert.equal(await cell('T50', day, 22), 0, 'dropped off the leaderboard: 0 mentions, no rank');
  assert.equal(await cell('T50', day, 22, 'ranks'), null);
  assert.equal(await cell('NEWB', day, 20), 0, 'first seen later: the earlier reading slot is 0, not unknown');
  assert.equal(await cell('NEWB', day, 21), null);
  assert.equal(await cell('NEWB', day, 22), 77);
  const { rows: [n] } = await pool.query(`SELECT * FROM tickers WHERE ticker = 'T50'`);
  assert.deepEqual([n.ranked, n.mentions], [false, 0]);
});

test('a second run in the same half hour overwrites the first; a new day starts a new row', async () => {
  await resetRave(pool);
  await runCollection(pool, { fetchLeaderboard: fake(), at: at(0) });
  await runCollection(pool, { fetchLeaderboard: fake(leaderboard({ bump: { GME: 5 } })), at: at(10) }); // same slot 20
  assert.equal(await cell('GME', DAY0, 20), 995);
  await runCollection(pool, { fetchLeaderboard: fake(), at: new Date(Date.parse(`${DAY1}T00:10:00Z`)) });
  assert.equal(await cell('GME', DAY1, 0), 990);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ticker_days WHERE ticker = 'GME'`)).rows[0].n, 2);
});

test('a failed fetch is recorded and writes nothing', async () => {
  await resetRave(pool);
  const result = await runCollection(pool, { fetchLeaderboard: async () => { throw new Error('boom: upstream down'); } });
  assert.equal(result.status, 'failed');
  const { rows: [run] } = await pool.query('SELECT * FROM collection_runs');
  assert.equal(run.status, 'failed');
  assert.match(run.error, /boom/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ticker_days')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM market_days')).rows[0].n, 0);
});

test('a database error mid-write rolls the whole run back', async () => {
  await resetRave(pool);
  const bad = leaderboard();
  bad.rows[10].mentions = 2 ** 40; // overflows the INTEGER column
  const result = await runCollection(pool, { fetchLeaderboard: fake(bad) });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /out of range/);
  for (const t of ['ticker_days', 'market_days', 'raw_snapshots']) {
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, 0, `${t} stays empty`);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tickers WHERE fetched_at < now() - interval \'1 second\'')).rows[0].n, 0);
});

test('skips when collected recently, and runs again when the interval has passed', async () => {
  await resetRave(pool);
  assert.equal((await runCollection(pool, { fetchLeaderboard: fake() })).status, 'success');
  const again = await runCollection(pool, { fetchLeaderboard: fake() });
  assert.equal(again.status, 'skipped');
  assert.match(again.reason, /recently/);
  assert.equal((await runCollection(pool, { fetchLeaderboard: fake(), minIntervalMs: 0 })).status, 'success');
});

test('skips while another process holds the lock', async () => {
  await resetRave(pool);
  const other = await pool.connect();
  try {
    await other.query('SELECT pg_advisory_lock(727275)');
    const result = await runCollection(pool, { fetchLeaderboard: fake() });
    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /lock/);
  } finally {
    await other.query('SELECT pg_advisory_unlock(727275)');
    other.release();
  }
  assert.equal((await runCollection(pool, { fetchLeaderboard: fake() })).status, 'success');
});

test('marks abandoned runs as failed and prunes raw responses older than 7 days', async () => {
  await resetRave(pool);
  await pool.query(`INSERT INTO collection_runs (kind, status, started_at) VALUES ('apewisdom', 'running', now() - interval '1 hour')`);
  const { rows: [old] } = await pool.query(`INSERT INTO collection_runs (kind, status, started_at) VALUES ('apewisdom', 'failed', now() - interval '10 days') RETURNING id`);
  await pool.query(
    `INSERT INTO raw_snapshots (run_id, source, filter, page, fetched_at, payload) VALUES ($1, 'apewisdom', 'all-stocks', 1, now() - interval '10 days', '{}')`,
    [old.id]
  );
  assert.equal((await runCollection(pool, { fetchLeaderboard: fake() })).status, 'success');
  const { rows: [abandoned] } = await pool.query(`SELECT * FROM collection_runs WHERE id = 1`);
  assert.equal(abandoned.status, 'failed');
  assert.match(abandoned.error, /abandoned/);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM raw_snapshots WHERE run_id = $1`, [old.id])).rows[0].n, 0);
});

test('storage is compact: about 1 KB or less per ticker per day once cleaned up', async () => {
  await resetRave(pool);
  for (let i = 0; i < 20; i++) {
    await runCollection(pool, { fetchLeaderboard: fake(leaderboard({ bump: { GME: i } })), at: at(i * 30) });
    await pool.query('VACUUM ticker_days'); // what autovacuum does between runs that are 30 minutes apart in production
  }
  const { rows: [r] } = await pool.query(`SELECT pg_total_relation_size('ticker_days')::float / count(*) AS per_row, count(*)::int AS n FROM ticker_days`);
  assert.ok(r.n >= 150);
  assert.ok(r.per_row < 1500, `${Math.round(r.per_row)} bytes per ticker-day (including indexes and update churn)`);
});
