// Loads the research universe from the database in the shape the long-horizon lab (lab2.js) wants, runs it and stores the result.
const { loadBars, dayNum } = require('./prices');
const { loadNews } = require('./news');
const { runLab2, fitBigMove, scoreBigMove, stockRows, prepareSpy } = require('./lab2');

const BIG_MOVE_H = 20; // sessions

// Wikipedia views as one dense 32-bit array per article (day number of the first value, then one value per calendar day; NaN where missing).
// The generic loader makes an object per day, which for 1,500 stocks over six years is several hundred megabytes.
async function loadViews(pool, articles, { days = 2400 } = {}) {
  const out = new Map();
  if (!articles.length) return out;
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 7) + '-01';
  const { rows } = await pool.query('SELECT article, month::text AS month, views FROM wiki_months WHERE article = ANY($1) AND month >= $2 ORDER BY article, month', [articles, from]);
  const byArticle = new Map();
  for (const r of rows) { if (!byArticle.has(r.article)) byArticle.set(r.article, []); byArticle.get(r.article).push(r); }
  for (const [article, months] of byArticle) {
    const start = dayNum(months[0].month.slice(0, 7) + '-01');
    const lastMonth = months[months.length - 1];
    const end = dayNum(lastMonth.month.slice(0, 7) + '-01') + lastMonth.views.length - 1;
    const values = new Float32Array(end - start + 1).fill(NaN);
    for (const m of months) {
      const base = dayNum(m.month.slice(0, 7) + '-01') - start;
      m.views.forEach((v, i) => { if (v !== null) values[base + i] = v; });
    }
    out.set(article, { start, values });
  }
  return out;
}

const MIN_SESSIONS = 350; // a year of history for the features plus some to test on

async function loadLab2Data(pool) {
  const { rows: members } = await pool.query(`SELECT ticker, added_day::text AS added, removed_day::text AS removed, active FROM universe`);
  const { rows: pages } = await pool.query('SELECT ticker, article FROM wiki_pages WHERE article IS NOT NULL');
  const article = new Map(pages.map((p) => [p.ticker, p.article]));
  const tickers = members.map((m) => m.ticker);
  const bars = await loadBars(pool, [...tickers, 'SPY']);
  const spyBars = bars.get('SPY');
  if (!spyBars) return { stocks: [], spy: null, coverage: { members: members.length, withPrices: 0 } };
  const views = await loadViews(pool, [...new Set(tickers.map((t) => article.get(t)).filter(Boolean))], { days: 2400 });
  const news = await loadNews(pool, tickers);
  const stocks = [];
  let removedTotal = 0, removedWithPrices = 0;
  for (const m of members) {
    const b = bars.get(m.ticker);
    if (!m.active) removedTotal++;
    if (!b || b.days.length < MIN_SESSIONS) continue;
    if (!m.active) removedWithPrices++;
    const v = article.has(m.ticker) ? views.get(article.get(m.ticker)) || null : null;
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
  const result = await runLab2({ stocks, spy, horizons, B }, { keepPanel: true });
  const panel = result.panel;
  delete result.panel;
  result.coverage = coverage;
  result.seconds = Math.round((Date.now() - started) / 1000);
  await pool.query(`INSERT INTO validation_runs (kind, params, results) VALUES ('lab2', $1, $2)`, [JSON.stringify({ horizons, B }), JSON.stringify(result)]);
  if (panel && result.status === 'ok') await runBigMove(pool, panel, spy, result.horizons[BIG_MOVE_H], stocks);
  return { status: result.status, stocks: stocks.length, observations: result.observations, seconds: result.seconds, memoryMb: Math.round(process.memoryUsage().rss / 1e6) };
}

// Today's chance that a stock makes a big move (at least 2 times its own typical move over the next 20 sessions, up or down), for every
// stock in the universe and every recently mentioned Reddit stock. Stored with the calibration table so the numbers can be checked.
async function runBigMove(pool, panel, spyBars, entry, universeStocks) {
  const fit = fitBigMove(panel, BIG_MOVE_H);
  const spy = prepareSpy(spyBars);
  const scores = {};
  const asOf = new Date(spyBars.days[spyBars.days.length - 1] * 86400000).toISOString().slice(0, 10);
  const score = (stock) => {
    const rows = stockRows(stock, spy, { horizons: [], last: true });
    if (rows.length) scores[stock.ticker] = Math.round(scoreBigMove(fit, rows[0]) * 1000) / 1000;
  };
  for (const st of universeStocks) if (st.removedDay == null) score(st);
  const { rows: reddit } = await pool.query(`SELECT ticker FROM tickers WHERE last_seen >= now() - interval '14 days'`);
  const todo = reddit.map((r) => r.ticker).filter((t) => !(t in scores));
  for (let i = 0; i < todo.length; i += 100) {
    const bars = await loadBars(pool, todo.slice(i, i + 100));
    for (const [ticker, b] of bars) if (b.days.length >= MIN_SESSIONS) score({ ticker, bars: b, addedDay: null, removedDay: null, views: null, news: null });
    await new Promise((r) => setImmediate(r));
  }
  const results = { asOf, H: BIG_MOVE_H, base: fit.base, trainRows: fit.n, auc: entry?.models?.[0]?.stage1?.auc ?? null, calibration: entry?.calibration || [], scores };
  await pool.query(`INSERT INTO validation_runs (kind, params, results) VALUES ('bigmove', $1, $2)`, [JSON.stringify({ H: BIG_MOVE_H }), JSON.stringify(results)]);
  return Object.keys(scores).length;
}

module.exports = { loadLab2Data, runLab2Job, runBigMove };
