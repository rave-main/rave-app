// Raw research data for offline analysis, paged: per stock the daily bars, Wikipedia page views, results dates and news. Compact arrays, no per-row objects.
const { listStocks } = require('./tracked');
const { loadBars } = require('./prices');
const { loadWikiSeries } = require('./wiki');
const { loadNews } = require('./news');

const DAY = 86400000;
const r4 = (x) => Math.round(x * 10000) / 10000;

// Every stock with prices and a Wikipedia page, in a stable order: universe members first, then the rest of the Reddit stocks
async function labTickers(pool) {
  const [stocks, { rows: index }, { rows: pages }, { rows: have }] = await Promise.all([
    listStocks(pool),
    pool.query('SELECT ticker, name, index_name AS "index", sector, added_day::text AS "addedDay", removed_day::text AS "removedDay", active FROM universe'),
    pool.query('SELECT ticker, article FROM wiki_pages WHERE article IS NOT NULL'),
    pool.query('SELECT ticker, cardinality(days) AS n FROM bars'),
  ]);
  const article = new Map(pages.map((p) => [p.ticker, p.article]));
  const bars = new Map(have.map((h) => [h.ticker, h.n]));
  const meta = new Map();
  for (const i of index) meta.set(i.ticker, { ticker: i.ticker, name: i.name, index: i.index, sector: i.sector, addedDay: i.addedDay, removedDay: i.removedDay, active: i.active, reddit: false });
  for (const s of stocks) meta.set(s.ticker, { ...(meta.get(s.ticker) || { ticker: s.ticker, name: s.name, index: null, sector: null }), reddit: true, mentions: s.mentions });
  return [...meta.values()].filter((m) => (bars.get(m.ticker) || 0) >= 120 && m.ticker !== 'SPY')
    .map((m) => ({ ...m, article: article.get(m.ticker) || null })).sort((a, b) => a.ticker.localeCompare(b.ticker));
}

async function exportLab(pool, { offset = 0, limit = 40 } = {}) {
  const all = await labTickers(pool);
  const page = all.slice(offset, offset + limit);
  const tickers = page.map((p) => p.ticker);
  const [bars, views, { rows: er }, news] = await Promise.all([
    loadBars(pool, [...tickers, ...(offset === 0 ? ['SPY'] : [])]),
    loadWikiSeries(pool, [...new Set(page.map((p) => p.article).filter(Boolean))]),
    pool.query('SELECT ticker, day::text AS day FROM earnings_dates WHERE ticker = ANY($1) ORDER BY day', [tickers]),
    loadNews(pool, tickers),
  ]);
  const earn = new Map();
  for (const e of er) { if (!earn.has(e.ticker)) earn.set(e.ticker, []); earn.get(e.ticker).push(e.day); }
  const packBars = (b) => ({ days: [...b.days], open: [...b.open].map(r4), close: [...b.close].map(r4), volume: [...b.volume].map(Math.round) });
  const stocks = page.map((p) => {
    const pts = (p.article && views.get(p.article)) || [];
    let vs = null, v = [];
    if (pts.length) {
      vs = new Date(pts[0].t).toISOString().slice(0, 10);
      v = Array((pts[pts.length - 1].t - pts[0].t) / DAY + 1).fill(null);
      for (const q of pts) v[Math.round((q.t - pts[0].t) / DAY)] = q.mentions;
    }
    const nw = news.get(p.ticker) || [];
    return {
      ...p, bars: bars.has(p.ticker) ? packBars(bars.get(p.ticker)) : null, viewsStart: vs, views: v, earnings: earn.get(p.ticker) || [],
      news: nw.length ? { days: nw.map((n) => n.day), tone: nw.map((n) => n.tone), vol: nw.map((n) => n.vol) } : null,
    };
  });
  return { total: all.length, offset, limit, spy: offset === 0 && bars.has('SPY') ? packBars(bars.get('SPY')) : undefined, stocks };
}

module.exports = { exportLab, labTickers };
