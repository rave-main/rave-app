const apewisdom = require('./apewisdom');

const LOCK_KEY = 727275; // advisory lock so overlapping deploys never collect at the same time
const SOURCE = 'apewisdom';
const KIND = 'apewisdom';
const TOP_N_STORED = 100; // watchlist tickers are always stored; so is the top of the leaderboard
const MIN_INTERVAL_MS = 10 * 60 * 1000; // restarts and overlapping deploys must not hammer the source
const ABANDONED_AFTER_MIN = 15;
const RAW_RETENTION_DAYS = 30;
const INTERVAL_MS = 30 * 60 * 1000;
const JITTER_MS = 5 * 60 * 1000;

// Rows to store for one run: every watchlist ticker (0 mentions and ranked=false when it is not on the
// leaderboard) plus the top of the leaderboard so new names can be discovered later.
function selectRows(leaderboard, watchlist) {
  const byTicker = new Map(leaderboard.rows.map((r) => [r.ticker, r]));
  const rows = leaderboard.rows
    .filter((r) => r.rank <= TOP_N_STORED || watchlist.includes(r.ticker))
    .map((r) => ({ ...r, ranked: true }));
  for (const ticker of watchlist) {
    if (!byTicker.has(ticker)) {
      rows.push({ ticker, rank: null, mentions: 0, upvotes: null, rank24hAgo: null, mentions24hAgo: null, ranked: false });
    }
  }
  return rows;
}

async function runCollection(pool, { fetchLeaderboard = apewisdom.fetchLeaderboard, minIntervalMs = MIN_INTERVAL_MS } = {}) {
  const lock = await pool.connect();
  try {
    const { rows: [{ locked }] } = await lock.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
    if (!locked) return { status: 'skipped', reason: 'another run holds the lock' };

    await pool.query(
      `UPDATE collection_runs SET status = 'failed', finished_at = now(), error = 'abandoned (process stopped mid-run)'
       WHERE kind = $1 AND status = 'running' AND started_at < now() - make_interval(mins => $2)`,
      [KIND, ABANDONED_AFTER_MIN]
    );
    const { rows: recent } = await pool.query(
      `SELECT 1 FROM collection_runs WHERE kind = $1 AND status = 'success'
         AND started_at > now() - make_interval(secs => $2)`,
      [KIND, minIntervalMs / 1000]
    );
    if (recent.length) return { status: 'skipped', reason: 'collected recently' };

    const { rows: [run] } = await pool.query(
      `INSERT INTO collection_runs (kind, status) VALUES ($1, 'running') RETURNING id, started_at`,
      [KIND]
    );
    try {
      const { rows: watch } = await pool.query('SELECT ticker FROM watchlist WHERE active');
      const leaderboard = await fetchLeaderboard();
      const rows = selectRows(leaderboard, watch.map((w) => w.ticker));
      const marketTotal = leaderboard.rows.reduce((sum, r) => sum + r.mentions, 0);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const { page, payload } of leaderboard.rawPages) {
          await client.query(
            `INSERT INTO raw_snapshots (run_id, source, filter, page, fetched_at, payload) VALUES ($1, $2, $3, $4, $5, $6)`,
            [run.id, SOURCE, leaderboard.filter, page, run.started_at, JSON.stringify(payload)]
          );
        }
        for (const r of rows) {
          await client.query(
            `INSERT INTO snapshots (run_id, source, ticker, fetched_at, ranked, rank, mentions, upvotes, rank_24h_ago, mentions_24h_ago)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [run.id, SOURCE, r.ticker, run.started_at, r.ranked, r.rank, r.mentions, r.upvotes, r.rank24hAgo, r.mentions24hAgo]
          );
        }
        await client.query(
          `UPDATE collection_runs SET status = 'success', finished_at = now(), pages_fetched = $2, pages_total = $3,
             tickers_seen = $4, rows_written = $5, market_total_mentions = $6 WHERE id = $1`,
          [run.id, leaderboard.rawPages.length, leaderboard.totalPages, leaderboard.rows.length, rows.length, marketTotal]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      await pool.query(
        `DELETE FROM raw_snapshots WHERE fetched_at < now() - make_interval(days => $1)`,
        [RAW_RETENTION_DAYS]
      );
      return { status: 'success', runId: run.id, rows: rows.length, tickersSeen: leaderboard.rows.length, truncated: leaderboard.truncated };
    } catch (err) {
      await pool.query(
        `UPDATE collection_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`,
        [run.id, String(err.message || err).slice(0, 500)]
      );
      return { status: 'failed', runId: run.id, error: err.message };
    }
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    lock.release();
  }
}

// Runs once shortly after boot (catch-up after a deploy), then every ~30 minutes with jitter
function startCollector(pool, { log = console } = {}) {
  let timer;
  let stopped = false;
  const tick = async () => {
    try {
      const result = await runCollection(pool);
      log.log(`RAVE collector: ${JSON.stringify(result)}`);
    } catch (err) {
      log.error('RAVE collector crashed:', err);
    }
    if (!stopped) timer = setTimeout(tick, INTERVAL_MS + Math.random() * JITTER_MS);
  };
  timer = setTimeout(tick, 5000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

module.exports = { runCollection, startCollector, selectRows };
