// The scheduled Wikipedia job: resolve articles for newly tracked tickers, then top up daily views for every article.
const { listStocks } = require('./tracked');
const wiki = require('./wiki');

const RERESOLVE_AFTER_DAYS = 7; // unresolved tickers are retried weekly (the name may improve, or Wikipedia may gain a page)

async function runWikipedia(pool, { log = console, deadlineMs = 8 * 60 * 1000, pauseMs = 300, fetchImpl = fetch, now = Date.now() } = {}) {
  const started = Date.now();
  const opts = { fetchImpl, pauseMs };
  const tracked = await listStocks(pool); // one entry per company (share classes merged)
  const details = { tracked: tracked.length, newlyResolved: 0, unresolved: 0, articlesFetched: 0, daysAdded: 0, errors: [], partial: false };

  // 1. which article is each ticker's company?
  const { rows: mapped } = await pool.query(`SELECT ticker, status, source, checked_at FROM wiki_pages`);
  const byTicker = new Map(mapped.map((m) => [m.ticker, m]));
  const cutoff = now - RERESOLVE_AFTER_DAYS * wiki.DAY_MS;
  const toResolve = tracked.filter((t) => {
    const m = byTicker.get(t.ticker);
    return !m || (m.source === 'auto' && m.status !== 'resolved' && new Date(m.checked_at).getTime() < cutoff);
  });
  for (let i = 0; i < toResolve.length; i += 20) {
    if (Date.now() - started > deadlineMs) { details.partial = true; break; }
    const chunk = toResolve.slice(i, i + 20);
    const results = await wiki.resolveArticles(chunk.map((t) => ({ ticker: t.ticker, name: t.name })), opts);
    for (const r of results) {
      await pool.query(
        `INSERT INTO wiki_pages (ticker, article, status, confidence, source, extract, rejected_article, checked_at)
         VALUES ($1, $2, $3, $4, 'auto', $5, $6, now())
         ON CONFLICT (ticker) DO UPDATE SET article = EXCLUDED.article, status = EXCLUDED.status, confidence = EXCLUDED.confidence,
           extract = EXCLUDED.extract, rejected_article = EXCLUDED.rejected_article, checked_at = now()
         WHERE wiki_pages.source = 'auto'`,
        [r.ticker, r.article, r.status, r.confidence, r.extract, r.rejectedArticle || null]
      );
      if (r.article) details.newlyResolved++;
    }
  }

  // 2. top up daily views for every distinct article of a tracked ticker
  const { rows: articles } = await pool.query(
    `SELECT DISTINCT p.article FROM wiki_pages p WHERE p.article IS NOT NULL ORDER BY p.article`
  );
  const yesterday = wiki.isoDay(now - wiki.DAY_MS);
  let attempted = 0;
  for (const { article } of articles) {
    if (Date.now() - started > deadlineMs) { details.partial = true; break; }
    try {
      const last = await wiki.lastStoredDay(pool, article);
      const start = last ? wiki.isoDay(Date.parse(`${last}T00:00:00Z`) + wiki.DAY_MS) : wiki.isoDay(now - wiki.BACKFILL_DAYS * wiki.DAY_MS);
      if (start > yesterday) continue;
      attempted++;
      const rows = await wiki.fetchViews(article, start, yesterday, opts);
      details.daysAdded += await wiki.saveViews(pool, article, rows);
      details.articlesFetched++;
      await new Promise((r) => setTimeout(r, pauseMs));
    } catch (err) {
      details.errors.push(`${article}: ${String(err.message).slice(0, 120)}`);
    }
  }
  details.unresolved = tracked.filter((t) => !byTicker.get(t.ticker) || byTicker.get(t.ticker).status !== 'resolved').length - details.newlyResolved;
  details.errorCount = details.errors.length;
  details.errors = details.errors.slice(0, 10);
  // Mostly failing means the source is unhealthy: record the run as failed so it retries and the Data page shows why
  if (attempted >= 2 && details.errorCount >= Math.max(2, attempted * 0.5)) {
    throw new Error(`Wikipedia page views failing for ${details.errorCount} of ${attempted} articles, e.g. ${details.errors[0]}`);
  }
  return details;
}

module.exports = { runWikipedia };
