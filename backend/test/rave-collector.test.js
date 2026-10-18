const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { runCollection, selectRows } = require('../src/rave/collector');

let pool;
before(async () => ({ pool } = await setup()));
after(() => pool.end());

// A leaderboard of 150 tickers; GME is #3, AAPL #120 (outside the top 100), the rest of the watchlist is absent
function leaderboard({ extra = [] } = {}) {
  const rows = Array.from({ length: 150 }, (_, i) => ({
    ticker: `T${i + 1}`, name: `Company ${i + 1}`, rank: i + 1, mentions: 1000 - i * 5, upvotes: 50, rank24hAgo: i + 2, mentions24hAgo: 900 - i * 5,
  }));
  rows[2].ticker = 'GME';
  rows[119].ticker = 'AAPL';
  rows.push(...extra);
  return {
    filter: 'all-stocks',
    totalPages: 2,
    truncated: false,
    rows,
    rawPages: [{ page: 1, payload: { pages: 2, results: rows.slice(0, 100) } }, { page: 2, payload: { pages: 2, results: rows.slice(100) } }],
  };
}
const fakeFetch = (lb = leaderboard()) => async () => lb;
const clean = () => pool.query('TRUNCATE collection_runs, raw_snapshots, snapshots RESTART IDENTITY CASCADE');

test('a successful run stores raw pages, watchlist rows, the top 100 and run totals', async () => {
  await clean();
  const result = await runCollection(pool, { fetchLeaderboard: fakeFetch() });
  assert.equal(result.status, 'success');

  const { rows: [run] } = await pool.query('SELECT * FROM collection_runs');
  assert.equal(run.status, 'success');
  assert.equal(run.pages_fetched, 2);
  assert.equal(run.pages_total, 2);
  assert.equal(run.tickers_seen, 150);
  assert.equal(run.market_total_mentions, leaderboard().rows.reduce((s, r) => s + r.mentions, 0));

  assert.equal((await pool.query('SELECT count(*)::int AS n FROM raw_snapshots')).rows[0].n, 2);

  const snaps = Object.fromEntries((await pool.query('SELECT * FROM snapshots')).rows.map((r) => [r.ticker, r]));
  assert.equal(snaps.GME.rank, 3);
  assert.equal(snaps.GME.ranked, true);
  assert.equal(snaps.AAPL.rank, 120, 'a watchlist ticker outside the top 100 is still stored');
  assert.equal(snaps.T50.ranked, true, 'top-100 tickers are stored for discovery');
  assert.equal(snaps.T130, undefined, 'tickers outside the top 100 that are not on the watchlist are not stored');
  assert.equal(snaps.AMC.ranked, false, 'watchlist tickers missing from the leaderboard are stored as not ranked');
  assert.equal(snaps.AMC.mentions, 0);
  assert.equal(snaps.AMC.rank, null);
  assert.equal(new Date(snaps.GME.fetched_at).getTime(), new Date(run.started_at).getTime());
});

test('a failed fetch is recorded and writes no snapshots', async () => {
  await clean();
  const result = await runCollection(pool, {
    fetchLeaderboard: async () => {
      throw new Error('boom: upstream down');
    },
  });
  assert.equal(result.status, 'failed');
  const { rows: [run] } = await pool.query('SELECT * FROM collection_runs');
  assert.equal(run.status, 'failed');
  assert.match(run.error, /boom/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM snapshots')).rows[0].n, 0);
});

test('a database error mid-write rolls the whole run back', async () => {
  await clean();
  const bad = leaderboard();
  bad.rows[0].mentions = 2 ** 40; // overflows the INTEGER column
  const result = await runCollection(pool, { fetchLeaderboard: fakeFetch(bad) });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /out of range/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM snapshots')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM raw_snapshots')).rows[0].n, 0);
});

test('skips when collected recently, and runs again when the interval has passed', async () => {
  await clean();
  assert.equal((await runCollection(pool, { fetchLeaderboard: fakeFetch() })).status, 'success');
  const again = await runCollection(pool, { fetchLeaderboard: fakeFetch() });
  assert.equal(again.status, 'skipped');
  assert.match(again.reason, /recently/);
  assert.equal((await runCollection(pool, { fetchLeaderboard: fakeFetch(), minIntervalMs: 0 })).status, 'success');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM collection_runs WHERE status = 'success'")).rows[0].n, 2);
});

test('skips while another process holds the lock', async () => {
  await clean();
  const other = await pool.connect();
  try {
    await other.query('SELECT pg_advisory_lock(727275)');
    const result = await runCollection(pool, { fetchLeaderboard: fakeFetch() });
    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /lock/);
  } finally {
    await other.query('SELECT pg_advisory_unlock(727275)');
    other.release();
  }
  assert.equal((await runCollection(pool, { fetchLeaderboard: fakeFetch() })).status, 'success');
});

test('marks abandoned runs as failed and prunes old raw responses', async () => {
  await clean();
  await pool.query(`INSERT INTO collection_runs (kind, status, started_at) VALUES ('apewisdom', 'running', now() - interval '1 hour')`);
  const { rows: [old] } = await pool.query(`INSERT INTO collection_runs (kind, status, started_at) VALUES ('apewisdom', 'failed', now() - interval '40 days') RETURNING id`);
  await pool.query(
    `INSERT INTO raw_snapshots (run_id, source, filter, page, fetched_at, payload) VALUES ($1, 'apewisdom', 'all-stocks', 1, now() - interval '40 days', '{}')`,
    [old.id]
  );

  assert.equal((await runCollection(pool, { fetchLeaderboard: fakeFetch() })).status, 'success');

  const { rows: [abandoned] } = await pool.query(`SELECT * FROM collection_runs WHERE id = 1`);
  assert.equal(abandoned.status, 'failed');
  assert.match(abandoned.error, /abandoned/);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM raw_snapshots WHERE run_id = $1`, [old.id])).rows[0].n, 0);
});

test('selectRows keeps the top 100, watchlist tickers and adds unranked placeholders', () => {
  const rows = selectRows(leaderboard(), ['GME', 'AAPL', 'AMC']);
  const byTicker = Object.fromEntries(rows.map((r) => [r.ticker, r]));
  assert.equal(rows.length, 100 + 1 /* AAPL */ + 1 /* AMC */);
  assert.equal(byTicker.AMC.ranked, false);
  assert.equal(byTicker.AAPL.ranked, true);
});
