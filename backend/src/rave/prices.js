// Daily price data (open, high, low, close, volume) for the tracked stocks, from free sources:
// Yahoo Finance's chart endpoint first (adjusted for splits), Stooq as a fallback (unadjusted CSV).
// Both are unofficial and free, so every call is polite (spaced, retried with backoff) and failures are visible.
const BROWSER_UA = 'Mozilla/5.0 (compatible; RAVE-research/1.0; +https://github.com/rave-main/rave-app)';
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';
const STOOQ = 'https://stooq.com/q/d/l/';
const DAY_MS = 86400000;
const BACKFILL_DAYS = 5 * 365;
const FULL_REFRESH_DAYS = 7; // splits rewrite history, so the whole series is re-fetched weekly (daily runs only top up)

class PriceError extends Error {}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// ApeWisdom writes class shares with a dot ("BRK.B"); Yahoo and Stooq use a dash
const yahooSymbol = (ticker) => ticker.replace(/\./g, '-').toUpperCase();

async function getText(url, { fetchImpl = fetch, retries = 3, retryDelayMs = 2000, timeoutMs = 25000, headers = {} } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json,text/csv,*/*', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) {
        lastError = new PriceError(`HTTP ${res.status} from ${new URL(url).host}`);
        if (attempt < retries) await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw Object.assign(new PriceError(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 100).replace(/\s+/g, ' ')}`), { fatal: true });
      return text;
    } catch (err) {
      if (err.fatal) throw err;
      lastError = err;
      if (attempt < retries) await sleep(retryDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

// ---------- Yahoo ----------
function parseYahoo(text, symbol) {
  let body;
  try { body = JSON.parse(text); } catch { throw new PriceError(`Yahoo returned non-JSON for ${symbol}`); }
  const err = body?.chart?.error;
  if (err) throw new PriceError(`Yahoo: ${err.description || err.code} (${symbol})`);
  const r = body?.chart?.result?.[0];
  if (!r || !Array.isArray(r.timestamp)) throw new PriceError(`Yahoo: no price data for ${symbol}`);
  const q = r.indicators?.quote?.[0];
  if (!q) throw new PriceError(`Yahoo: malformed response for ${symbol}`);
  const adj = r.indicators?.adjclose?.[0]?.adjclose;
  const offset = r.meta?.gmtoffset || 0; // timestamps are the market open; shift to the exchange's local date
  const rows = [];
  r.timestamp.forEach((ts, i) => {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if ([o, h, l, c].some((v) => v === null || v === undefined || !Number.isFinite(v))) return; // holidays and half-filled rows
    rows.push({ day: isoDay((ts + offset) * 1000), open: o, high: h, low: l, close: c, adjClose: adj?.[i] ?? c, volume: q.volume?.[i] ?? 0 });
  });
  return rows;
}

async function fetchYahoo(ticker, fromDay, toDay, opts = {}) {
  const symbol = yahooSymbol(ticker);
  const p1 = Math.floor(Date.parse(`${fromDay}T00:00:00Z`) / 1000);
  const p2 = Math.floor(Date.parse(`${toDay}T00:00:00Z`) / 1000) + 86400;
  const url = `${YAHOO}/${encodeURIComponent(symbol)}?interval=1d&period1=${p1}&period2=${p2}&includeAdjustedClose=true&events=div%2Csplits`;
  return parseYahoo(await getText(url, opts), symbol);
}

// ---------- Stooq ----------
function parseStooq(text, symbol) {
  const t = text.trim();
  if (!t.startsWith('Date,')) throw new PriceError(`Stooq: ${t.slice(0, 80).replace(/\s+/g, ' ') || 'empty response'} (${symbol})`);
  const rows = [];
  for (const line of t.split(/\r?\n/).slice(1)) {
    const [day, o, h, l, c, v] = line.split(',');
    const nums = [o, h, l, c].map(Number);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || nums.some((n) => !Number.isFinite(n))) continue;
    rows.push({ day, open: nums[0], high: nums[1], low: nums[2], close: nums[3], adjClose: nums[3], volume: Number(v) || 0 });
  }
  return rows;
}

async function fetchStooq(ticker, fromDay, toDay, opts = {}) {
  const symbol = `${yahooSymbol(ticker).toLowerCase()}.us`;
  const url = `${STOOQ}?s=${encodeURIComponent(symbol)}&i=d&d1=${fromDay.replace(/-/g, '')}&d2=${toDay.replace(/-/g, '')}`;
  return parseStooq(await getText(url, opts), symbol);
}

// Yahoo first, Stooq if Yahoo fails. Returns { rows, source }.
async function fetchPrices(ticker, fromDay, toDay, opts = {}) {
  const sources = opts.sources || [['yahoo', fetchYahoo], ['stooq', fetchStooq]];
  const errors = [];
  for (const [source, fn] of sources) {
    try {
      const rows = await fn(ticker, fromDay, toDay, opts);
      if (rows.length || source === sources[sources.length - 1][0]) return { rows, source };
      errors.push(`${source}: no rows`);
    } catch (err) {
      errors.push(`${source}: ${String(err.message).slice(0, 100)}`);
    }
  }
  throw new PriceError(errors.join(' | '));
}

// ---------- storage ----------
async function savePrices(pool, ticker, rows, source) {
  if (!rows.length) return 0;
  await pool.query(
    `INSERT INTO prices (ticker, day, open, high, low, close, adj_close, volume, source)
     SELECT $1, d, o, h, l, c, a, v, $9
     FROM unnest($2::date[], $3::float8[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[]) AS x(d, o, h, l, c, a, v)
     ON CONFLICT (ticker, day) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
       adj_close = EXCLUDED.adj_close, volume = EXCLUDED.volume, source = EXCLUDED.source`,
    [ticker, rows.map((r) => r.day), rows.map((r) => r.open), rows.map((r) => r.high), rows.map((r) => r.low), rows.map((r) => r.close),
      rows.map((r) => r.adjClose), rows.map((r) => r.volume), source]
  );
  return rows.length;
}

async function loadPrices(pool, tickers, { fromDay = '1900-01-01' } = {}) {
  const { rows } = await pool.query(
    `SELECT ticker, day::text AS day, open, high, low, close, adj_close AS "adjClose", volume FROM prices WHERE ticker = ANY($1) AND day >= $2 ORDER BY ticker, day`,
    [tickers, fromDay]
  );
  const out = new Map(tickers.map((t) => [t, []]));
  for (const r of rows) out.get(r.ticker).push(r);
  return out;
}

module.exports = { fetchPrices, fetchYahoo, fetchStooq, parseYahoo, parseStooq, savePrices, loadPrices, yahooSymbol, getText, PriceError, BACKFILL_DAYS, FULL_REFRESH_DAYS, DAY_MS, isoDay, BROWSER_UA };
