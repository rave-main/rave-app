const express = require('express');
const { wrap } = require('../auth');
const { loadSeries } = require('./series');
const { scoreStock } = require('./scoring');

const STALE_AFTER_MIN = 90; // the collector runs about every 30 minutes

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
    res.json(rows.map((r) => ({ ...r, scores: scoreStock(series.get(r.ticker), { ticker: r.ticker }) })));
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
    const ageMin = lastSuccess ? (Date.now() - new Date(lastSuccess.startedAt).getTime()) / 60000 : null;
    res.json({
      source: 'apewisdom',
      stale: ageMin === null || ageMin > STALE_AFTER_MIN,
      minutesSinceLastSuccess: ageMin === null ? null : Math.round(ageMin),
      lastSuccess: lastSuccess || null,
      lastRun: lastRun || null,
      last24h: counts,
      history,
    });
  }));

  return router;
}

module.exports = { raveRouter };
