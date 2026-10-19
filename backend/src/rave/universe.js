// The research universe: every stock in the S&P 500, S&P 400 (mid caps) and S&P 600 (small caps), about 1,500 US companies, read from
// Wikipedia's index lists. Unlike the stocks that happen to be popular on Reddit today, this list does not depend on hindsight about which
// stocks did something, so it is a fairer place to test whether attention carries information. The lists also name each company's Wikipedia
// article, which is more reliable than matching by name.
const wiki = require('./wiki');

const PAGES = [
  ['sp500', 'List_of_S&P_500_companies'],
  ['sp400', 'List_of_S&P_400_companies'],
  ['sp600', 'List_of_S&P_600_companies'],
];
const REFRESH_AFTER_DAYS = 6;

const strip = (html) => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#160;|&nbsp;/g, ' ').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/\s+/g, ' ').trim();
const SYMBOL = /^[A-Z][A-Z0-9]{0,5}([.-][A-Z0-9]{1,2})?$/;

// Finds the constituents table: the one with the most rows whose first cell is a ticker and whose second cell names the company
function parseIndexTable(html) {
  const tables = html.split(/<table\b/i).slice(1);
  let best = [];
  for (const table of tables) {
    const rows = [];
    for (const tr of table.split(/<tr\b/i).slice(1)) {
      const cells = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      if (cells.length < 2) continue;
      const symbol = strip(cells[0]).replace(/\s/g, '').toUpperCase();
      if (!SYMBOL.test(symbol)) continue;
      const link = cells[1].match(/<a\b[^>]*href="\/wiki\/([^"#?]+)"[^>]*>/i);
      const titleAttr = cells[1].match(/<a\b[^>]*title="([^"]+)"/i);
      const name = strip(cells[1]);
      if (!name) continue;
      const red = /redlink=1|class="new"/.test(cells[1]);
      const article = !red && link ? decodeURIComponent(link[1]).replace(/_/g, ' ') : !red && titleAttr ? strip(titleAttr[1]) : null;
      rows.push({ ticker: symbol.replace(/-/g, '.'), name, article, sector: cells[2] ? strip(cells[2]) : null });
    }
    if (rows.length > best.length) best = rows;
  }
  return best;
}

async function fetchIndex(page, opts = {}) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json&formatversion=2&redirects=1`;
  const body = await wiki.getJson(url, opts);
  const html = body?.parse?.text;
  if (typeof html !== 'string') throw new wiki.WikiError(`no table in ${page}`);
  return parseIndexTable(html);
}

async function saveUniverse(pool, indexName, rows) {
  let n = 0;
  for (const r of rows) {
    await pool.query(
      `INSERT INTO universe (ticker, name, article, index_name, sector, checked_at) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (ticker) DO UPDATE SET name = EXCLUDED.name, article = coalesce(EXCLUDED.article, universe.article), index_name = EXCLUDED.index_name, sector = EXCLUDED.sector, checked_at = now()`,
      [r.ticker, r.name, r.article, indexName, r.sector]
    );
    // Wikipedia page for the stock, taken from the list. Never overrides a choice made by hand or an existing automatic match.
    if (r.article) {
      await pool.query(
        `INSERT INTO wiki_pages (ticker, article, status, confidence, source, checked_at) VALUES ($1, $2, 'resolved', 'high', 'index', now()) ON CONFLICT (ticker) DO NOTHING`,
        [r.ticker, r.article]
      );
    }
    n++;
  }
  return n;
}

async function runUniverse(pool, { log = console, fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  const { rows: [last] } = await pool.query('SELECT max(checked_at) AS at FROM universe');
  if (!force && last.at && now - new Date(last.at).getTime() < REFRESH_AFTER_DAYS * 86400000) return { skipped: 'refreshed recently', refreshedAt: last.at };
  const details = { lists: {}, total: 0, errors: [] };
  for (const [name, page] of PAGES) {
    try {
      const rows = await fetchIndex(page, { fetchImpl });
      if (rows.length < 100) throw new Error(`only ${rows.length} rows found`);
      details.lists[name] = await saveUniverse(pool, name, rows);
      details.total += details.lists[name];
    } catch (err) {
      details.errors.push(`${name}: ${String(err.message).slice(0, 120)}`);
    }
  }
  if (!details.total) throw new Error(`no index list could be read: ${details.errors.join('; ')}`);
  return details;
}

module.exports = { runUniverse, parseIndexTable, fetchIndex, PAGES };
