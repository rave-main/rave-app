// News attention and tone per stock from GDELT (a free index of world news): for each of the most talked-about stocks, the share of all news that
// mentions the company ("volume") and the average tone of those articles (negative = bad news), one value per day. GDELT allows one request every
// 5 seconds, so a full pass over a few hundred stocks takes an hour or two and runs in slices that continue by themselves.
const wiki = require('./wiki');
const { stockKind } = require('./stock-kind');

const GDELT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const MIN_GAP_MS = 7000;
const TOP_STOCKS = 300;
const HISTORY = '1y'; // GDELT's long timelines are daily; this is what a first pass fetches
const TOP_UP = '1month';
const TOP_UP_EVERY_HOURS = 20;

let lastRequest = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "Tesla, Inc." -> Tesla; the query adds finance words so that "Apple" or "Block" means the company
const COMPANY_SUFFIX = /[\s,]+(inc\.?|incorporated|corp\.?|corporation|co\.?|company|ltd\.?|limited|plc|llc|holdings?|group|class [a-c]|the)\b\.?/gi;
function newsQuery(name) {
  const clean = String(name).replace(/\(.*?\)/g, '').replace(COMPANY_SUFFIX, '').replace(/[",]/g, ' ').replace(/\s+/g, ' ').trim();
  return `"${clean}" (stock OR shares OR earnings OR stocks) sourcelang:english`;
}

async function gdelt(query, mode, timespan, { fetchImpl = fetch, gapMs = MIN_GAP_MS, retries = 3 } = {}) {
  const url = `${GDELT}?query=${encodeURIComponent(query)}&mode=${mode}&format=json&timespan=${timespan}`;
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = lastRequest + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': wiki.USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(40000) });
      const text = await res.text();
      if (res.status === 429) { last = new Error('GDELT asked to slow down (HTTP 429)'); await sleep(gapMs * 3 * (attempt + 1)); continue; }
      if (!res.ok) throw Object.assign(new Error(`GDELT HTTP ${res.status}`), { fatal: true });
      if (!text.trim()) return []; // no matching articles
      let body;
      try { body = JSON.parse(text); } catch { throw Object.assign(new Error(`GDELT said: ${text.slice(0, 80).replace(/\s+/g, ' ')}`), { fatal: true }); }
      return body?.timeline?.[0]?.data || [];
    } catch (err) {
      if (err.fatal) throw err;
      last = err;
      await sleep(gapMs * 2 * (attempt + 1)); // a dropped connection: wait longer before trying again
    }
  }
  throw last;
}

// Points -> one value per UTC day (mean of the points that fall in the day)
function perDay(points) {
  const sum = new Map();
  for (const p of points) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(p.date || '');
    if (!m || typeof p.value !== 'number' || !Number.isFinite(p.value)) continue;
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    const cur = sum.get(d) || [0, 0];
    sum.set(d, [cur[0] + p.value, cur[1] + 1]);
  }
  return new Map([...sum].map(([d, [s, n]]) => [d, s / n]));
}

async function saveNews(pool, ticker, tone, vol) {
  const months = new Map();
  for (const [d, v] of tone) { const k = `${d.slice(0, 7)}-01`; if (!months.has(k)) months.set(k, { tone: Array(31).fill(null), vol: Array(31).fill(null) }); months.get(k).tone[Number(d.slice(8, 10)) - 1] = v; }
  for (const [d, v] of vol) { const k = `${d.slice(0, 7)}-01`; if (!months.has(k)) months.set(k, { tone: Array(31).fill(null), vol: Array(31).fill(null) }); months.get(k).vol[Number(d.slice(8, 10)) - 1] = v; }
  for (const [month, m] of months) {
    // merge with what is stored (a top-up covers only the last weeks of a month)
    const { rows: [cur] } = await pool.query('SELECT tone, vol FROM news_months WHERE ticker = $1 AND month = $2', [ticker, month]);
    const tone2 = m.tone.map((v, i) => v ?? cur?.tone?.[i] ?? null);
    const vol2 = m.vol.map((v, i) => v ?? cur?.vol?.[i] ?? null);
    await pool.query(
      `INSERT INTO news_months (ticker, month, tone, vol) VALUES ($1, $2, $3::real[], $4::real[])
       ON CONFLICT (ticker, month) DO UPDATE SET tone = EXCLUDED.tone, vol = EXCLUDED.vol`,
      [ticker, month, tone2, vol2]
    );
  }
  return months.size;
}

async function loadNews(pool, tickers) {
  const { rows } = await pool.query('SELECT ticker, month::text AS month, tone, vol FROM news_months WHERE ticker = ANY($1) ORDER BY ticker, month', [tickers]);
  const out = new Map(tickers.map((t) => [t, []]));
  for (const r of rows) {
    const [y, mo] = r.month.split('-').map(Number);
    r.tone.forEach((tone, i) => { if (tone !== null || r.vol[i] !== null) out.get(r.ticker).push({ day: `${y}-${String(mo).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`, tone, vol: r.vol[i] }); });
  }
  return out;
}

async function runNews(pool, { log = console, deadlineMs = 8 * 60 * 1000, fetchImpl = fetch, gapMs = MIN_GAP_MS, now = Date.now(), top = TOP_STOCKS } = {}) {
  const started = Date.now();
  const { rows: stocks } = await pool.query(
    `SELECT t.ticker, coalesce(p.article, t.name, t.ticker) AS name FROM tickers t LEFT JOIN wiki_pages p ON p.ticker = t.ticker
     WHERE t.last_seen >= now() - interval '7 days' ORDER BY t.mentions DESC, t.ticker LIMIT $1`, [top * 2]
  ).then((r) => ({ rows: r.rows.filter((s) => stockKind(s.ticker, s.name) === 'company').slice(0, top) })); // funds have no company news
  const { rows: seen } = await pool.query('SELECT ticker, max(fetched_at) AS at, bool_or(history) AS history FROM news_checks GROUP BY ticker');
  const by = new Map(seen.map((s) => [s.ticker, s]));
  const due = stocks.filter((s) => !by.has(s.ticker) || now - new Date(by.get(s.ticker).at).getTime() > TOP_UP_EVERY_HOURS * 3600000)
    .sort((a, b) => (by.has(a.ticker) ? 1 : 0) - (by.has(b.ticker) ? 1 : 0));
  const details = { stocks: stocks.length, due: due.length, fetched: 0, errors: [], partial: false };
  let streak = 0;
  for (const s of due) {
    if (Date.now() - started > deadlineMs) { details.partial = true; break; }
    const first = !by.has(s.ticker);
    const span = first ? HISTORY : TOP_UP;
    try {
      const q = newsQuery(s.name);
      const tone = perDay(await gdelt(q, 'timelinetone', span, { fetchImpl, gapMs }));
      const vol = perDay(await gdelt(q, 'timelinevol', span, { fetchImpl, gapMs }));
      await saveNews(pool, s.ticker, tone, vol);
      await pool.query(
        `INSERT INTO news_checks (ticker, fetched_at, history, days) VALUES ($1, now(), $2, $3)
         ON CONFLICT (ticker) DO UPDATE SET fetched_at = now(), history = news_checks.history OR $2, days = $3`, [s.ticker, first, tone.size]
      );
      details.fetched++;
      streak = 0;
    } catch (err) {
      details.errors.push(`${s.ticker}: ${String(err.message).slice(0, 100)}`);
      streak++;
      if (streak >= 8) break;
    }
  }
  details.errorCount = details.errors.length;
  details.errors = details.errors.slice(0, 8);
  if (streak >= 8 || (details.fetched === 0 && details.errorCount > 0)) throw new Error(`GDELT news failing, e.g. ${details.errors[0]}`);
  return details;
}

module.exports = { runNews, newsQuery, perDay, gdelt, saveNews, loadNews };
