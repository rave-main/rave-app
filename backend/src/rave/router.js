const express = require('express');
const { wrap } = require('../auth');
const { loadSeries } = require('./series');
const { scoreStock } = require('./scoring');
const { auditRuns } = require('./audit');

const STALE_AFTER_MIN = 90; // the collector runs about every 30 minutes
const EXPECTED_INTERVAL_MIN = 30;
// Railway's Postgres volume is 500 MB on the current plan; set DB_SIZE_LIMIT_MB if it is resized
const DB_LIMIT_MB = Number(process.env.DB_SIZE_LIMIT_MB) || 500;

// ApeWisdom's own comparison with 24 hours earlier; available from the very first snapshot
function dayOverDay(r) {
  if (r.mentions24hAgo === null || r.mentions24hAgo === undefined) return null;
  return {
    change: r.mentions - r.mentions24hAgo,
    ratio: r.mentions24hAgo > 0 ? r.mentions / r.mentions24hAgo : null,
  };
}

// One fingerprint per run over every stored (ticker, mentions) pair: when it differs from the previous
// run's, ApeWisdom's data actually changed, as opposed to RAVE merely having checked.
const RUNS_WITH_CHANGE = `
  WITH fp AS (
    SELECT run_id, md5(string_agg(ticker || ':' || mentions, ',' ORDER BY ticker)) AS fp
    FROM snapshots WHERE fetched_at > now() - interval '7 days' GROUP BY run_id
  ), ok AS (
    -- compare each successful run with the previous SUCCESSFUL run, so a failure in between does not hide a change
    SELECT c.id, f.fp, lag(f.fp) OVER (ORDER BY c.started_at) AS prev_fp
    FROM collection_runs c JOIN fp f ON f.run_id = c.id
    WHERE c.kind = 'apewisdom' AND c.status = 'success' AND c.started_at > now() - interval '7 days'
  )
  SELECT c.id, c.status, c.started_at, c.finished_at, c.pages_fetched, c.pages_total, c.tickers_seen, c.rows_written,
         c.market_total_mentions, c.error,
         CASE WHEN o.prev_fp IS NULL THEN NULL ELSE o.fp <> o.prev_fp END AS changed
  FROM collection_runs c LEFT JOIN ok o ON o.id = c.id
  WHERE c.kind = 'apewisdom' AND c.started_at > now() - interval '7 days'`;

function raveRouter(pool) {
  const router = express.Router();

  router.get('/watchlist', wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT ticker, name, is_control AS "isControl", active FROM watchlist ORDER BY is_control, ticker'
    );
    res.json(rows);
  }));

  // Latest snapshot and RAVE scores (short / medium / long) for each active watchlist stock
  router.get('/stocks', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT w.ticker, w.name, w.is_control AS "isControl",
              s.fetched_at AS "fetchedAt", s.ranked, s.rank, s.mentions, s.upvotes,
              s.rank_24h_ago AS "rank24hAgo", s.mentions_24h_ago AS "mentions24hAgo"
       FROM watchlist w
       LEFT JOIN LATERAL (
         SELECT * FROM snapshots WHERE ticker = w.ticker ORDER BY fetched_at DESC LIMIT 1
       ) s ON true
       WHERE w.active ORDER BY w.is_control, w.ticker`
    );
    const series = await loadSeries(pool, rows.map((r) => r.ticker));
    res.json(rows.map((r) => ({
      ...r,
      dayOverDay: dayOverDay(r),
      spark: series.get(r.ticker).slice(-48).map((p) => p.mentions), // about the last 24 hours
      scores: scoreStock(series.get(r.ticker), { ticker: r.ticker }),
    })));
  }));

  // Re-verifies stored data against the raw responses (last `runs` successful runs, default 48 = about a day)
  router.get('/integrity', wrap(async (req, res) => {
    const runs = Math.min(Math.max(parseInt(req.query.runs, 10) || 48, 1), 500);
    res.json(await auditRuns(pool, { runs }));
  }));

  // Recent collection runs, newest first, each flagged with whether ApeWisdom's data changed since the run before
  router.get('/runs', wrap(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 200);
    const { rows } = await pool.query(
      `WITH runs AS (${RUNS_WITH_CHANGE})
       SELECT id, status, started_at AS "startedAt", finished_at AS "finishedAt",
              extract(epoch FROM finished_at - started_at)::float AS "durationSec",
              pages_fetched AS "pagesFetched", pages_total AS "pagesTotal", tickers_seen AS "tickersSeen",
              rows_written AS "rowsWritten", market_total_mentions AS "marketTotalMentions", error, changed
       FROM runs ORDER BY started_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  }));

  // One stock: latest snapshot, full score explanations and its history (hours = 1..2160, default 168)
  router.get('/stocks/:ticker', wrap(async (req, res) => {
    const ticker = req.params.ticker.toUpperCase();
    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 168, 1), 2160);
    const { rows: [stock] } = await pool.query(
      'SELECT ticker, name, is_control AS "isControl", active FROM watchlist WHERE ticker = $1', [ticker]
    );
    if (!stock) return res.status(404).json({ error: 'Stock not on the watchlist' });
    const series = (await loadSeries(pool, [ticker])).get(ticker);
    const since = Date.now() - hours * 3600 * 1000;
    const latest = series[series.length - 1] || null;
    res.json({
      ...stock,
      latest: latest && { ...latest, dayOverDay: dayOverDay({ mentions: latest.mentions, mentions24hAgo: latest.mentions24hAgo }) },
      scores: scoreStock(series, { ticker }),
      history: series.filter((p) => p.t >= since).map((p) => ({ t: p.t, mentions: p.mentions, rank: p.rank, ranked: p.ranked, market: p.market })),
    });
  }));

  // Source health: how fresh the data is, how much history exists, and how recent runs went
  router.get('/status', wrap(async (req, res) => {
    const [{ rows: [lastSuccess] }, { rows: [lastRun] }, { rows: [counts] }, { rows: [history] }] = await Promise.all([
      pool.query(`SELECT id, started_at AS "startedAt", finished_at AS "finishedAt", pages_fetched AS "pagesFetched",
                         pages_total AS "pagesTotal", tickers_seen AS "tickersSeen", rows_written AS "rowsWritten",
                         market_total_mentions AS "marketTotalMentions"
                  FROM collection_runs WHERE kind = 'apewisdom' AND status = 'success' ORDER BY started_at DESC LIMIT 1`),
      pool.query(`SELECT id, status, started_at AS "startedAt", finished_at AS "finishedAt", error
                  FROM collection_runs WHERE kind = 'apewisdom' ORDER BY started_at DESC LIMIT 1`),
      pool.query(`SELECT count(*) FILTER (WHERE status = 'success')::int AS success,
                         count(*) FILTER (WHERE status = 'failed')::int AS failed
                  FROM collection_runs WHERE kind = 'apewisdom' AND started_at > now() - interval '24 hours'`),
      pool.query(`SELECT min(fetched_at) AS "firstSnapshotAt", count(DISTINCT fetched_at)::int AS snapshots FROM snapshots`),
    ]);
    const { rows: [{ bytes }] } = await pool.query('SELECT pg_database_size(current_database())::float AS bytes');
    const sizeMB = Math.round(bytes / 1048576);
    const { rows: [change] } = await pool.query(
      `WITH runs AS (${RUNS_WITH_CHANGE})
       SELECT max(started_at) FILTER (WHERE changed) AS "lastChangeAt",
              count(*) FILTER (WHERE status = 'success' AND started_at > coalesce((SELECT max(started_at) FROM runs WHERE changed), '-infinity'))::int AS "unchangedRuns"
       FROM runs`
    );
    const ageMin = lastSuccess ? (Date.now() - new Date(lastSuccess.startedAt).getTime()) / 60000 : null;
    res.json({
      source: 'apewisdom',
      now: new Date().toISOString(),
      stale: ageMin === null || ageMin > STALE_AFTER_MIN,
      minutesSinceLastSuccess: ageMin === null ? null : Math.round(ageMin),
      expectedIntervalMinutes: EXPECTED_INTERVAL_MIN,
      database: { sizeMB, limitMB: DB_LIMIT_MB, usedPercent: Math.round((100 * sizeMB) / DB_LIMIT_MB) },
      lastChangeAt: change.lastChangeAt,
      unchangedRuns: change.unchangedRuns,
      lastSuccess: lastSuccess || null,
      lastRun: lastRun || null,
      last24h: counts,
      history,
    });
  }));

  return router;
}

module.exports = { raveRouter };
