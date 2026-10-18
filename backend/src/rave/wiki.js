// Wikipedia page views: a second, independent attention signal that SUPPLEMENTS the Reddit mentions.
// Daily views of a company's English Wikipedia article (people only, no bots), free from Wikimedia, history back years.
// Two steps: (1) work out which article is a ticker's company (candidate titles from the name, checked against
// Wikipedia), (2) pull daily views and store them compactly (one row per article per month).
const USER_AGENT = 'RAVE-research/1.0 (+https://github.com/rave-main/rave-app)';
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const PAGEVIEWS = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user';
const BACKFILL_DAYS = 5 * 365;
const DAY_MS = 86400000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

class WikiError extends Error {}

// GET JSON with retries. Wikimedia rate-limits shared addresses: honour Retry-After, back off, never hammer.
async function getJson(url, { fetchImpl = fetch, retries = 4, timeoutMs = 20000, retryDelayMs = 1500, notFoundIsEmpty = false } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 404 && notFoundIsEmpty) return null;
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        lastError = new WikiError(`HTTP ${res.status} from ${url.split('?')[0]}`);
        if (attempt < retries) await sleep(Math.min(60000, retryAfter > 0 ? retryAfter * 1000 : retryDelayMs * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw Object.assign(new WikiError(`HTTP ${res.status} from ${url.split('?')[0]}`), { fatal: true });
      return await res.json();
    } catch (err) {
      if (err.fatal) throw err;
      lastError = err;
      if (attempt < retries) await sleep(retryDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

// ---------- 1. which article? ----------
const SUFFIXES = /[\s,]+(inc\.?|incorporated|corp\.?|corporation|co\.?|company|ltd\.?|limited|plc|llc|l\.p\.|lp|n\.v\.|nv|s\.a\.|sa|ag|se|holdings?|holding|class [a-c]|common stock|ordinary shares?|adr|ads|depositary shares?)\b\.?/gi;

const decodeEntities = (t) => t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// Titles to try, most specific first. Wikipedia titles for companies vary ("Tesla, Inc.", "Apple Inc.", "Micron Technology").
// ApeWisdom names can carry HTML entities ("S&amp;P"), parentheticals ("Meta Platforms (Facebook)") and fund-family
// prefixes ("Vanguard Group, Inc. - Vanguard Total World Stock ETF"), so several cleaned-up bases are tried.
function candidateTitles(name) {
  if (!name) return [];
  const raw = decodeEntities(String(name)).replace(/\s+/g, ' ').trim();
  const noParen = raw.replace(/\s*\([^)]*\)/g, '').trim();
  const afterDash = raw.includes(' - ') ? raw.split(' - ').pop().trim() : null;
  const strip = (t) => t.replace(SUFFIXES, '').replace(/[\s,.]+$/, '').trim();
  const noFundWord = (t) => t.replace(/\s+(ETF Trust|ETF|Index Fund|Fund|Trust)$/i, '').trim();
  const bases = [strip(raw), raw, strip(noParen), noParen, afterDash && strip(afterDash), afterDash, afterDash && noFundWord(afterDash), noFundWord(strip(raw)), noFundWord(raw)];
  const out = [];
  const add = (t) => t && t.length > 1 && !out.includes(t) && out.push(t);
  for (const base of bases) {
    if (!base) continue;
    add(`${base}, Inc.`);
    add(`${base} Inc.`);
    add(`${base} (company)`);
    add(base);
  }
  for (const base of bases.slice(0, 4)) {
    if (!base) continue;
    add(`${base} Corporation`);
    add(`${base} Holdings`);
    add(`${base} Group`);
    add(`${base} Technologies`);
  }
  return out.slice(0, 18);
}

const POSITIVE = /\b(company|corporation|multinational|conglomerate|manufacturer|retailer|bank|holding company|exchange-traded|ETF|index fund|investment|technology|software|semiconductor|airline|automaker|automotive|pharmaceutical|biotechnology|chain|brand|enterprise|firm|trust|fund|platform|producer|provider|operator|developer|supplier)\b/i;
const NEGATIVE = /\b(may refer to|is a (village|town|city|municipality|commune|river|species|genus|surname|given name|film|album|song|band|novel|television|footballer|politician)|disambiguation)\b/i;
const EXCHANGE = /\b(NYSE|Nasdaq|NASDAQ|NYSE American|LSE|TSX|Euronext)\b/;

// Does a Wikipedia lead paragraph look like a listed company or fund? Heuristic, so the mapping is visible and editable.
function judgeExtract(extract, ticker) {
  if (!extract) return { ok: false, confidence: 'none' };
  if (NEGATIVE.test(extract) && !POSITIVE.test(extract.slice(0, 200))) return { ok: false, confidence: 'none' };
  const mentionsTicker = new RegExp(`(NYSE|Nasdaq|NASDAQ|NYSE American|LSE|TSX)[:\\s]+${ticker}\\b`).test(extract) || new RegExp(`\\b${ticker}\\b`).test(extract);
  if (mentionsTicker && EXCHANGE.test(extract)) return { ok: true, confidence: 'high' };
  return POSITIVE.test(extract) ? { ok: true, confidence: 'medium' } : { ok: false, confidence: 'none' };
}

// Asks Wikipedia about many titles at once. Returns Map(requested title -> { title, missing, disambiguation, redirected })
async function lookupTitles(titles, opts = {}) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 40) {
    const chunk = titles.slice(i, i + 40);
    const url = `${WIKI_API}?action=query&format=json&formatversion=2&redirects=1&prop=pageprops&ppprop=disambiguation&titles=${encodeURIComponent(chunk.join('|'))}`;
    const body = await getJson(url, opts);
    const q = body?.query;
    if (!q) throw new WikiError('unexpected response from the Wikipedia API (no query)');
    const norm = new Map((q.normalized || []).map((n) => [n.from, n.to]));
    const redir = new Map((q.redirects || []).map((r) => [r.from, r.to]));
    const pages = new Map((q.pages || []).map((p) => [p.title, p]));
    for (const requested of chunk) {
      let t = norm.get(requested) || requested;
      const normalized = t;
      let hops = 0;
      while (redir.has(t) && hops++ < 5) t = redir.get(t);
      const page = pages.get(t);
      out.set(requested, { title: t, missing: !page || page.missing === true || page.invalid === true, disambiguation: Boolean(page?.pageprops && 'disambiguation' in page.pageprops), redirected: t !== normalized });
    }
    if (i + 40 < titles.length) await sleep(opts.pauseMs ?? 250);
  }
  return out;
}

async function fetchExtracts(titles, opts = {}) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 20) {
    const chunk = titles.slice(i, i + 20);
    const url = `${WIKI_API}?action=query&format=json&formatversion=2&prop=extracts&exintro=1&explaintext=1&exchars=600&exlimit=max&titles=${encodeURIComponent(chunk.join('|'))}`;
    const body = await getJson(url, opts);
    for (const p of body?.query?.pages || []) out.set(p.title, p.extract || '');
    if (i + 20 < titles.length) await sleep(opts.pauseMs ?? 250);
  }
  return out;
}

// stocks: [{ ticker, name }]. Returns [{ ticker, article, status, confidence, extract, candidates }]
async function resolveArticles(stocks, opts = {}) {
  const wanted = stocks.map((s) => ({ ...s, candidates: candidateTitles(s.name) }));
  const all = [...new Set(wanted.flatMap((s) => s.candidates))];
  const found = all.length ? await lookupTitles(all, opts) : new Map();
  const picked = wanted.map((s) => {
    for (const c of s.candidates) {
      const f = found.get(c);
      if (f && !f.missing && !f.disambiguation) return { ...s, article: f.title };
    }
    return { ...s, article: null };
  });
  const titles = [...new Set(picked.filter((p) => p.article).map((p) => p.article))];
  const extracts = titles.length ? await fetchExtracts(titles, opts) : new Map();
  return picked.map((p) => {
    if (!p.article) return { ticker: p.ticker, article: null, status: 'unresolved', confidence: 'none', extract: null, candidates: p.candidates };
    const extract = extracts.get(p.article) || '';
    const j = judgeExtract(extract, p.ticker);
    return { ticker: p.ticker, article: j.ok ? p.article : null, status: j.ok ? 'resolved' : 'rejected', confidence: j.confidence, extract: extract.slice(0, 300), candidates: p.candidates, rejectedArticle: j.ok ? null : p.article };
  });
}

// ---------- 2. daily views ----------
const articlePath = (article) => encodeURIComponent(article.replace(/ /g, '_'));

// Daily views between two dates (inclusive, 'YYYY-MM-DD'). No data for the range is an empty list, not an error.
async function fetchViews(article, startDay, endDay, opts = {}) {
  const url = `${PAGEVIEWS}/${articlePath(article)}/daily/${startDay.replace(/-/g, '')}00/${endDay.replace(/-/g, '')}00`;
  const body = await getJson(url, { ...opts, notFoundIsEmpty: true });
  if (!body) return [];
  if (!Array.isArray(body.items)) throw new WikiError(`unexpected pageviews response for ${article}`);
  return body.items.map((i) => ({ day: `${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}-${i.timestamp.slice(6, 8)}`, views: Number(i.views) }));
}

// ---------- storage: one row per article per month, 31 day slots ----------
async function saveViews(pool, article, rows) {
  if (!rows.length) return 0;
  const byMonth = new Map();
  for (const r of rows) {
    const month = `${r.day.slice(0, 7)}-01`;
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(r);
  }
  const months = [...byMonth.keys()];
  const { rows: existing } = await pool.query(`SELECT month::text AS month, views FROM wiki_months WHERE article = $1 AND month = ANY($2::date[])`, [article, months]);
  const have = new Map(existing.map((e) => [e.month, e.views]));
  for (const [month, list] of byMonth) {
    const arr = have.get(month) ? [...have.get(month)] : Array(31).fill(null);
    for (const r of list) arr[Number(r.day.slice(8, 10)) - 1] = r.views;
    await pool.query(
      `INSERT INTO wiki_months (article, month, views) VALUES ($1, $2, $3) ON CONFLICT (article, month) DO UPDATE SET views = EXCLUDED.views`,
      [article, month, arr]
    );
  }
  return rows.length;
}

// Daily points {t, mentions} for scoring ("mentions" is the common field name; here it holds page views)
async function loadWikiSeries(pool, articles, { days = 800 } = {}) {
  const out = new Map(articles.map((a) => [a, []]));
  if (!articles.length) return out;
  const from = isoDay(Date.now() - days * DAY_MS).slice(0, 7) + '-01';
  const { rows } = await pool.query(`SELECT article, month::text AS month, views FROM wiki_months WHERE article = ANY($1) AND month >= $2 ORDER BY article, month`, [articles, from]);
  for (const r of rows) {
    r.views.forEach((v, i) => {
      if (v !== null) out.get(r.article).push({ t: Date.parse(`${r.month.slice(0, 7)}-${String(i + 1).padStart(2, '0')}T00:00:00Z`), mentions: v, market: null, ranked: true, rank: null, rank24hAgo: null, mentions24hAgo: null });
    });
  }
  return out;
}

async function lastStoredDay(pool, article) {
  const { rows: [r] } = await pool.query(`SELECT max(month + (SELECT max(i) - 1 FROM generate_subscripts(views, 1) AS i WHERE views[i] IS NOT NULL) * interval '1 day')::date::text AS day FROM wiki_months WHERE article = $1`, [article]);
  return r?.day || null;
}

module.exports = { USER_AGENT, candidateTitles, judgeExtract, lookupTitles, fetchExtracts, resolveArticles, fetchViews, saveViews, loadWikiSeries, lastStoredDay, getJson, BACKFILL_DAYS, WikiError, isoDay, DAY_MS };
