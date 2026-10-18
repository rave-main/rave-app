const crypto = require('crypto');
const apewisdom = require('./apewisdom');
const { storeRun } = require('./store');

const LOCK_KEY = 727275; // advisory lock so overlapping deploys never collect at the same time
const SOURCE = 'apewisdom';
const KIND = 'apewisdom';
const MIN_INTERVAL_MS = 10 * 60 * 1000; // restarts and overlapping deploys must not hammer the source
const ABANDONED_AFTER_MIN = 15;
const RAW_RETENTION_DAYS = 7; // about 112 KB per run: 7 days is ~40 MB, and the Railway volume is 500 MB

// `at` backdates the run (tests only): production runs are stamped with the database clock
async function runCollection(pool, { fetchLeaderboard = apewisdom.fetchLeaderboard, minIntervalMs = MIN_INTERVAL_MS, at = null } = {}) {
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
    if (recent.length && !at) return { status: 'skipped', reason: 'collected recently' };

    const { rows: [run] } = await pool.query(
      `INSERT INTO collection_runs (kind, status, started_at) VALUES ($1, 'running', coalesce($2::timestamptz, now())) RETURNING id, started_at`,
      [KIND, at]
    );
    try {
      const leaderboard = await fetchLeaderboard();
      const rows = leaderboard.rows; // every ticker on the leaderboard is stored (compactly, see store.js)
      const marketTotal = rows.reduce((sum, r) => sum + r.mentions, 0);
      // Fingerprint of the numbers: when it differs from the previous run's, the source's data actually changed
      const fp = crypto.createHash('md5').update(rows.map((r) => `${r.ticker}:${r.mentions}`).sort().join(',')).digest('hex');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const { page, payload } of leaderboard.rawPages) {
          await client.query(
            `INSERT INTO raw_snapshots (run_id, source, filter, page, fetched_at, payload) VALUES ($1, $2, $3, $4, $5, $6)`,
            [run.id, SOURCE, leaderboard.filter, page, run.started_at, JSON.stringify(payload)]
          );
        }
        await storeRun(client, { startedAt: run.started_at, rows, marketTotal });
        await client.query(
          `UPDATE collection_runs SET status = 'success', finished_at = now(), pages_fetched = $2, pages_total = $3,
             tickers_seen = $4, rows_written = $5, market_total_mentions = $6, details = $7 WHERE id = $1`,
          [run.id, leaderboard.rawPages.length, leaderboard.totalPages, rows.length, rows.length, marketTotal, JSON.stringify({ fp })]
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
      return { status: 'success', runId: run.id, rows: rows.length, tickersSeen: rows.length, truncated: leaderboard.truncated };
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

module.exports = { runCollection };
