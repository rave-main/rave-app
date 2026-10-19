const express = require('express');
const { wrap } = require('../auth');
const { loadSeries } = require('./series');
const { auditRuns } = require('./audit');
const { scoredStocks, listStocks, dayOverDay, mergeSeries } = require('./tracked');
const { jobsStatus } = require('./scheduler');
const { buildJobs } = require('./jobs');
const { runCollection } = require('./collector');
const { runRecorded } = require('./scheduler');
const { runDiagnostics, candidateProbes, candidateProbes2 } = require('./diagnostics');
const { loadWikiSeries } = require('./wiki');
const { ledgerSummary, loadBacktestData } = require('./research');
const { loadPrices } = require('./prices');

const STALE_AFTER_MIN = 90; // the collector runs every 30 minutes
const EXPECTED_INTERVAL_MIN = 30;
// Railway's Postgres volume is 500 MB on the current plan; set DB_SIZE_LIMIT_MB if it is resized
const DB_LIMIT_MB = Number(process.env.DB_SIZE_LIMIT_MB) || 500;

// Each successful run stores an md5 fingerprint of the leaderboard numbers (details.fp). When it differs from the
// previous successful run's, the source's data actually changed, as opposed to RAVE merely having checked.
const RUNS_WITH_CHANGE = `
  WITH ok AS (
    SELECT id, details->>'fp' AS fp, lag(details->>'fp') OVER (ORDER BY started_at) AS prev_fp
    FROM collection_runs
    WHERE kind = 'apewisdom' AND status = 'success' AND started_at > now() - interval '7 days'
  )
  SELECT c.id, c.status, c.started_at, c.finished_at, c.pages_fetched, c.pages_total, c.tickers_seen, c.rows_written,
         c.market_total_mentions, c.error,
         CASE WHEN o.fp IS NULL OR o.prev_fp IS NULL THEN NULL ELSE o.fp <> o.prev_fp END AS changed
  FROM collection_runs c LEFT JOIN ok o ON o.id = c.id
  WHERE c.kind = 'apewisdom' AND c.started_at > now() - interval '7 days'`;

function raveRouter(pool) {
  const router = express.Router();
  const jobs = buildJobs();

  // Every stock on the leaderboard (share classes merged) with RAVE scores, Wikipedia signal and latest price
  router.get('/stocks', wrap(async (req, res) => {
    res.json(await scoredStocks(pool));
  }));

  // One stock: latest state, full score explanations and its history (hours = 1..2160, default 168).
  // Accepts any share-class ticker of a company (GOOG shows the GOOGL page).
  router.get('/stocks/:ticker', wrap(async (req, res) => {
    const ticker = req.params.ticker.toUpperCase();
    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 168, 1), 2160);
    const stocks = await scoredStocks(pool);
    const stock = stocks.find((s) => s.tickers.includes(ticker));
    if (!stock) {
      const { rows: [t] } = await pool.query('SELECT 1 FROM tickers WHERE ticker = $1', [ticker]);
      return res.status(404).json({ error: t ? 'This stock has not been on the leaderboard for a week' : 'Ticker not found' });
    }
    const main = stock.ticker;
    const loaded = await loadSeries(pool, stock.tickers);
    const series = mergeSeries(stock.tickers.map((t) => loaded.get(t)));
    const since = Date.now() - hours * 3600 * 1000;
    const latest = series[series.length - 1] || null;
    const { rows: [m] } = await pool.query('SELECT article, status, confidence, source, extract FROM wiki_pages WHERE ticker = $1', [main]);
    const wseries = m?.article ? (await loadWikiSeries(pool, [m.article])).get(m.article) : [];
    const priceRows = (await loadPrices(pool, [main], { fromDay: new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10) })).get(main);
    const { rows: spikes } = await pool.query(
      `SELECT detected_at AS "detectedAt", label, ratio, z, mentions, wiki_label AS "wikiLabel", entry_day::text AS "entryDay", entry_open AS "entryOpen", outcomes
       FROM spike_events WHERE ticker = $1 ORDER BY detected_at DESC LIMIT 20`, [main]
    );
    res.json({
      prices: priceRows.map((p) => ({ day: p.day, close: p.close })),
      price: stock.price,
      spikes,
      wiki: {
        article: m?.article || null, status: m?.status || 'pending', confidence: m?.confidence || 'none', source: m?.source || 'auto', extract: m?.extract || null,
        scores: stock.wiki.scores,
        history: wseries.filter((p) => p.t >= Date.now() - 400 * 86400000).map((p) => ({ t: p.t, views: p.mentions })),
      },
      ticker: main, tickers: stock.tickers, label: stock.label, name: stock.name,
      rank: stock.rank, rank24hAgo: stock.rank24hAgo, ranked: stock.ranked,
      latest: latest && { ...latest, dayOverDay: dayOverDay({ mentions: latest.mentions, mentions24hAgo: stock.mentions24hAgo }) },
      scores: stock.scores,
      history: series.filter((p) => p.t >= since).map((p) => ({ t: p.t, mentions: p.mentions, rank: p.rank, ranked: p.ranked, market: p.market })),
    });
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

  // The stock -> Wikipedia article mapping, for review (automatic matches are heuristic). One entry per company.
  router.get('/wiki', wrap(async (req, res) => {
    const stocks = await listStocks(pool);
    const { rows: pages } = await pool.query(
      `SELECT p.ticker, p.article, p.status, p.confidence, p.source, p.extract, p.rejected_article AS "rejectedArticle", p.checked_at AS "checkedAt",
              (SELECT max(month) FROM wiki_months m WHERE m.article = p.article) AS "lastMonth"
       FROM wiki_pages p WHERE p.ticker = ANY($1)`, [stocks.map((s) => s.ticker)]
    );
    const by = new Map(pages.map((p) => [p.ticker, p]));
    res.json(stocks.map((s) => ({ ticker: s.ticker, label: s.label, name: s.name, mentions: s.mentions, article: null, status: 'pending', confidence: 'none', source: 'auto', ...(by.get(s.ticker) || {}) })));
  }));

  // Correct (or clear) a ticker's Wikipedia article. A manual choice is never overwritten by the automatic matcher.
  router.put('/wiki/:ticker', express.json({ limit: '2kb' }), wrap(async (req, res) => {
    const ticker = req.params.ticker.toUpperCase();
    const article = req.body?.article === null ? null : String(req.body?.article || '').trim().replace(/_/g, ' ');
    if (article !== null && (!article || article.length > 200 || /[|<>#{}\[\]]/.test(article))) return res.status(400).json({ error: 'article must be a Wikipedia page title (or null to clear)' });
    const { rows: [t] } = await pool.query('SELECT 1 FROM tickers WHERE ticker = $1', [ticker]);
    if (!t) return res.status(404).json({ error: 'Ticker not found' });
    await pool.query(
      `INSERT INTO wiki_pages (ticker, article, status, confidence, source, checked_at) VALUES ($1, $2, 'override', 'manual', 'override', now())
       ON CONFLICT (ticker) DO UPDATE SET article = EXCLUDED.article, status = 'override', confidence = 'manual', source = 'override', checked_at = now()`,
      [ticker, article]
    );
    res.json({ ticker, article, source: 'override', note: 'page views for the new article are fetched at the next Wikipedia run (or run it now from the Data page)' });
  }));

  // Start a scheduled job right now (it still takes its lock, so it cannot overlap a scheduled run)
  router.post('/jobs/:kind/run', wrap(async (req, res) => {
    const job = jobs.find((j) => j.kind === req.params.kind);
    if (!job) return res.status(404).json({ error: 'Unknown job' });
    (job.selfRecording ? job.run(pool) : runRecorded(pool, job)).then((r) => console.log(`RAVE ${job.kind} (manual): ${JSON.stringify(r).slice(0, 300)}`)).catch((e) => console.error(`RAVE ${job.kind} (manual) crashed:`, e));
    res.status(202).json({ started: job.kind, note: 'running in the background; watch /api/rave/sources' });
  }));

  // Can this deployment reach each external source right now?
  router.get('/diagnostics', wrap(async (req, res) => {
    const results = await runDiagnostics(req.query.candidates === '2' ? candidateProbes2() : req.query.candidates ? candidateProbes() : []);
    res.json({ at: new Date().toISOString(), results });
  }));

  // Raw research data for offline analysis: Wikipedia daily views and daily prices per stock, in pages of `limit` stocks
  router.get('/export/backtest', wrap(async (req, res) => {
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 100);
    const { series, bench } = await loadBacktestData(pool);
    res.json({
      total: series.length, offset,
      bench: offset === 0 ? bench.map((b) => [b.day, b.open, b.high, b.low, b.close, b.volume]) : undefined,
      stocks: series.slice(offset, offset + limit).map((s) => ({ ticker: s.ticker, article: s.article, startDay: s.startDay, views: s.values, prices: s.prices.map((p) => [p.day, p.open, p.high, p.low, p.close, p.volume]) })),
    });
  }));

  // Research results: the latest Wikipedia backtest and the Reddit forward ledger
  router.get('/research', wrap(async (req, res) => {
    const { rows: [latest] } = await pool.query(`SELECT id, ran_at AS "ranAt", results FROM validation_runs WHERE kind = 'wiki_backtest' ORDER BY ran_at DESC LIMIT 1`);
    const { rows: [lab] } = await pool.query(`SELECT id, ran_at AS "ranAt", results FROM validation_runs WHERE kind = 'strategy_lab' ORDER BY ran_at DESC LIMIT 1`);
    res.json({ backtest: latest ? { id: latest.id, ranAt: latest.ranAt, ...latest.results } : null, lab: lab ? { id: lab.id, ranAt: lab.ranAt, ...lab.results } : null, ledger: await ledgerSummary(pool, 'reddit'), ledgerWiki: await ledgerSummary(pool, 'wiki') });
  }));

  // Every scheduled source: cadence, last success, next scheduled run, staleness
  router.get('/sources', wrap(async (req, res) => {
    res.json(await jobsStatus(pool, jobs));
  }));

  // Source health: how fresh the data is, how much history exists, and how recent runs went
  router.get('/status', wrap(async (req, res) => {
    const [{ rows: [lastSuccess] }, { rows: [lastRun] }, { rows: [counts] }, { rows: [history] }, { rows: [{ bytes }] }, { rows: [change] }] = await Promise.all([
      pool.query(`SELECT id, started_at AS "startedAt", finished_at AS "finishedAt", pages_fetched AS "pagesFetched",
                         pages_total AS "pagesTotal", tickers_seen AS "tickersSeen", rows_written AS "rowsWritten",
                         market_total_mentions AS "marketTotalMentions"
                  FROM collection_runs WHERE kind = 'apewisdom' AND status = 'success' ORDER BY started_at DESC LIMIT 1`),
      pool.query(`SELECT id, status, started_at AS "startedAt", finished_at AS "finishedAt", error
                  FROM collection_runs WHERE kind = 'apewisdom' ORDER BY started_at DESC LIMIT 1`),
      pool.query(`SELECT count(*) FILTER (WHERE status = 'success')::int AS success,
                         count(*) FILTER (WHERE status = 'failed')::int AS failed
                  FROM collection_runs WHERE kind = 'apewisdom' AND started_at > now() - interval '24 hours'`),
      pool.query(`SELECT min(md.day + (u.ord - 1) * interval '30 minutes') AS "firstSnapshotAt", count(*)::int AS snapshots
                  FROM market_days md, unnest(md.market) WITH ORDINALITY AS u(m, ord) WHERE u.m IS NOT NULL`),
      pool.query('SELECT pg_database_size(current_database())::float AS bytes'),
      pool.query(`WITH runs AS (${RUNS_WITH_CHANGE})
                  SELECT max(started_at) FILTER (WHERE changed) AS "lastChangeAt",
                         count(*) FILTER (WHERE status = 'success' AND started_at > coalesce((SELECT max(started_at) FROM runs WHERE changed), '-infinity'))::int AS "unchangedRuns"
                  FROM runs`),
    ]);
    const sizeMB = Math.round(bytes / 1048576);
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
