// Loads the research universe from the database in the shape the long-horizon lab (lab2.js) wants, runs it and stores the result.
const { loadBars, dayNum } = require('./prices');
const { loadWikiSeries } = require('./wiki');
const { loadNews } = require('./news');
const { runLab2 } = require('./lab2');

const MIN_SESSIONS = 350; // a year of history for the features plus some to test on

async function loadLab2Data(pool) {
  const { rows: members } = await pool.query(`SELECT ticker, added_day::text AS added, removed_day::text AS removed, active FROM universe`);
  const { rows: pages } = await pool.query('SELECT ticker, article FROM wiki_pages WHERE article IS NOT NULL');
  const article = new Map(pages.map((p) => [p.ticker, p.article]));
  const tickers = members.map((m) => m.ticker);
  const bars = await loadBars(pool, [...tickers, 'SPY']);
  const spyBars = bars.get('SPY');
  if (!spyBars) return { stocks: [], spy: null, coverage: { members: members.length, withPrices: 0 } };
  const views = await loadWikiSeries(pool, [...new Set(tickers.map((t) => article.get(t)).filter(Boolean))], { days: 2400 });
  const news = await loadNews(pool, tickers);
  const stocks = [];
  let removedTotal = 0, removedWithPrices = 0;
  for (const m of members) {
    const b = bars.get(m.ticker);
    if (!m.active) removedTotal++;
    if (!b || b.days.length < MIN_SESSIONS) continue;
    if (!m.active) removedWithPrices++;
    const pts = article.has(m.ticker) ? views.get(article.get(m.ticker)) || [] : [];
    let v = null;
    if (pts.length) {
      const start = Math.round(pts[0].t / 86400000);
      const values = Array(Math.round((pts[pts.length - 1].t - pts[0].t) / 86400000) + 1).fill(null);
      for (const p of pts) values[Math.round((p.t - pts[0].t) / 86400000)] = p.mentions;
      v = { start, values };
    }
    const nw = news.get(m.ticker) || [];
    stocks.push({
      ticker: m.ticker, addedDay: m.added ? dayNum(m.added) : null, removedDay: m.removed ? dayNum(m.removed) : null, bars: b, views: v,
      news: nw.length ? { tone: new Map(nw.filter((x) => x.tone !== null).map((x) => [dayNum(x.day), x.tone])), vol: new Map(nw.filter((x) => x.vol !== null).map((x) => [dayNum(x.day), x.vol])) } : null,
    });
  }
  return { stocks, spy: spyBars, coverage: { members: members.length, withPrices: stocks.length, removedTotal, removedWithPrices } };
}

async function runLab2Job(pool, { log = console, B = 300, horizons = [20, 60] } = {}) {
  const started = Date.now();
  const { stocks, spy, coverage } = await loadLab2Data(pool);
  if (!spy || stocks.length < 100) {
    const reason = `needs the benchmark and at least 100 stocks with a year of prices (have ${stocks.length})`;
    await pool.query(`INSERT INTO validation_runs (kind, params, results) VALUES ('lab2', '{}', $1)`, [JSON.stringify({ status: 'insufficient', reason, coverage })]);
    return { status: 'insufficient', reason };
  }
  const result = await runLab2({ stocks, spy, horizons, B });
  result.coverage = coverage;
  result.seconds = Math.round((Date.now() - started) / 1000);
  await pool.query(`INSERT INTO validation_runs (kind, params, results) VALUES ('lab2', $1, $2)`, [JSON.stringify({ horizons, B }), JSON.stringify(result)]);
  return { status: result.status, stocks: stocks.length, observations: result.observations, seconds: result.seconds };
}

module.exports = { loadLab2Data, runLab2Job };
