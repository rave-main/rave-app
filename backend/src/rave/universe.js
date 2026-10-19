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
// Pages that may hold the S&P 500 changes table when the main list page does not (tried in order until one yields changes)
const CHANGE_PAGES = { sp500: ['List_of_S&P_500_component_changes', 'Changes_to_the_S&P_500', 'S&P_500_index_changes'] };
const REFRESH_AFTER_DAYS = 6;

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const pad = (n) => String(n).padStart(2, '0');
// "October 6, 2025", "6 October 2025" or "2025-10-06" -> "2025-10-06"; anything else -> null
function parseDate(text) {
  const t = String(text).replace(/\[.*?\]/g, '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(t);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`;
  m = /^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/.exec(t);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
  return null;
}

const strip = (html) => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#160;|&nbsp;/g, ' ').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/\s+/g, ' ').trim();
const SYMBOL = /^[A-Z][A-Z0-9]{0,5}([.-][A-Z0-9]{1,2})?$/;

// Finds the constituents table: the one with the most rows whose first cell is a ticker and whose second cell names the company
function parseIndexTable(html) {
  const tables = html.split(/<table\b/i).slice(1);
  let best = [];
  for (const table of tables) {
    const rows = [];
    const header = [...(table.split(/<tr\b/i)[1] || '').matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => strip(m[1]).toLowerCase());
    const addedCol = header.findIndex((h) => /date.*added/.test(h));
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
      rows.push({ ticker: symbol.replace(/-/g, '.'), name, article, sector: cells[2] ? strip(cells[2]) : null, added: addedCol >= 0 && cells[addedCol] ? parseDate(strip(cells[addedCol])) : null });
    }
    if (rows.length > best.length) best = rows;
  }
  return best;
}

// The "selected changes" table: when a company joined or left the index. Rows repeat the date only once (rowspan), so a row without a date uses the one above.
function parseChanges(html) {
  const out = [];
  for (const table of html.split(/<table\b/i).slice(1)) {
    const head = (table.split(/<tr\b/i).slice(1, 3).join(' ')).toLowerCase();
    if (!/added/.test(head) || !/removed/.test(head)) continue;
    let day = null;
    for (const tr of table.split(/<tr\b/i).slice(1)) {
      // the date cell is a <th> on some pages, so both cell kinds are read
      const cells = [...tr.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => strip(m[1]));
      if (cells.length < 4) continue;
      let rest = cells;
      const d = parseDate(cells[0]);
      if (d) { day = d; rest = cells.slice(1); }
      if (!day) continue;
      const [addT, addName, remT, remName] = rest;
      const clean = (t) => (t && SYMBOL.test(t.replace(/\s/g, '').toUpperCase()) ? t.replace(/\s/g, '').toUpperCase().replace(/-/g, '.') : null);
      const added = clean(addT), removed = clean(remT);
      if (added || removed) out.push({ day, added, addedName: addName || null, removed, removedName: remName || null });
    }
  }
  return out;
}

async function fetchIndex(page, opts = {}) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json&formatversion=2&redirects=1`;
  const body = await wiki.getJson(url, opts);
  const html = body?.parse?.text;
  if (typeof html !== 'string') throw new wiki.WikiError(`no table in ${page}`);
  const changes = parseChanges(html);
  // when a page yields no changes, keep a short look at the tables that mention both words so the parser can be fixed from the deployed service
  const debug = changes.length ? null : {
    tables: html.split(/<table\b/i).length - 1, length: html.length,
    headings: [...html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)].map((m) => strip(m[1])).slice(0, 30),
    candidates: html.split(/<table\b/i).slice(1).filter((t) => /removed/i.test(t) && /added/i.test(t)).slice(0, 2).map((t) => t.replace(/\s+/g, ' ').slice(0, 700)),
  };
  return { rows: parseIndexTable(html), changes, debug };
}

// Current members, then the changes that happened since CHANGES_FROM: members join on their added date; companies that left (and are not in
// any index now) are kept as inactive rows with the day they left, so the research can use the membership as it was on each day
const CHANGES_FROM = '2021-01-01';
async function saveUniverse(pool, indexName, rows) {
  let n = 0;
  for (const r of rows) {
    await pool.query(
      `INSERT INTO universe (ticker, name, article, index_name, sector, added_day, removed_day, active, checked_at) VALUES ($1, $2, $3, $4, $5, $6, NULL, true, now())
       ON CONFLICT (ticker) DO UPDATE SET name = EXCLUDED.name, article = coalesce(EXCLUDED.article, universe.article), index_name = EXCLUDED.index_name, sector = EXCLUDED.sector,
         added_day = CASE WHEN universe.added_day IS NULL THEN EXCLUDED.added_day WHEN EXCLUDED.added_day IS NULL THEN universe.added_day ELSE LEAST(universe.added_day, EXCLUDED.added_day) END,
         removed_day = NULL, active = true, checked_at = now()`,
      [r.ticker, r.name, r.article, indexName, r.sector, r.added && r.added >= CHANGES_FROM ? r.added : null]
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

async function saveChanges(pool, indexName, changes) {
  let added = 0, removed = 0;
  for (const c of changes.filter((x) => x.day >= CHANGES_FROM)) {
    if (c.added) {
      const r = await pool.query(`UPDATE universe SET added_day = CASE WHEN added_day IS NULL THEN $2 ELSE LEAST(added_day, $2::date) END WHERE ticker = $1 AND active`, [c.added, c.day]);
      added += r.rowCount;
    }
    if (c.removed) {
      // a company that moved to another index (or came back) is still in the universe
      const r = await pool.query(
        `INSERT INTO universe (ticker, name, article, index_name, sector, added_day, removed_day, active, checked_at) VALUES ($1, $2, NULL, $3, NULL, NULL, $4, false, now())
         ON CONFLICT (ticker) DO UPDATE SET removed_day = CASE WHEN universe.active THEN NULL ELSE GREATEST(coalesce(universe.removed_day, $4::date), $4::date) END`,
        [c.removed, c.removedName || c.removed, indexName, c.day]
      );
      removed += r.rowCount;
    }
  }
  return { added, removed };
}

async function runUniverse(pool, { log = console, fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  const { rows: [last] } = await pool.query('SELECT max(checked_at) AS at FROM universe');
  if (!force && last.at && now - new Date(last.at).getTime() < REFRESH_AFTER_DAYS * 86400000) return { skipped: 'refreshed recently', refreshedAt: last.at };
  const details = { lists: {}, total: 0, changes: {}, errors: [] };
  const pending = [];
  for (const [name, page] of PAGES) {
    try {
      const { rows, changes, debug } = await fetchIndex(page, { fetchImpl });
      if (debug) (details.debug ||= {})[name] = debug;
      if (rows.length < 100) throw new Error(`only ${rows.length} rows found`);
      details.lists[name] = await saveUniverse(pool, name, rows);
      details.total += details.lists[name];
      let found = changes;
      for (const alt of changes.length ? [] : CHANGE_PAGES[name] || []) {
        try {
          const extra = await fetchIndex(alt, { fetchImpl });
          (details.debug ||= {})[`${name}:${alt}`] = extra.changes.length ? `${extra.changes.length} changes` : extra.debug;
          if (extra.changes.length) { found = extra.changes; break; }
        } catch (err) { (details.debug ||= {})[`${name}:${alt}`] = String(err.message).slice(0, 100); }
      }
      pending.push([name, found]);
    } catch (err) {
      details.errors.push(`${name}: ${String(err.message).slice(0, 120)}`);
    }
  }
  // changes are applied once every list is in, so a company that moved between indexes is not mistaken for one that left
  for (const [name, changes] of pending) details.changes[name] = { found: changes.length, ...(await saveChanges(pool, name, changes)) };
  if (!details.total) throw new Error(`no index list could be read: ${details.errors.join('; ')}`);
  return details;
}

module.exports = { runUniverse, parseIndexTable, parseChanges, parseDate, fetchIndex, PAGES };
