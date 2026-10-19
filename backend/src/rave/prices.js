// Daily price data (open, high, low, close, volume) in US dollars from Yahoo Finance's chart endpoint (adjusted for splits).
// It is unofficial and free, so every call is polite (spaced, retried with backoff) and failures are visible.
const BROWSER_UA = 'Mozilla/5.0 (compatible; RAVE-research/1.0; +https://github.com/rave-main/rave-app)';
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';
const DAY_MS = 86400000;
const BACKFILL_DAYS = 5 * 365; // five years, stored compactly (see savePrices)
const FULL_REFRESH_DAYS = 7; // splits rewrite history, so the whole series is re-fetched weekly (daily runs only top up)

class PriceError extends Error {}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// ApeWisdom writes class shares with a dot ("BRK.B"); Yahoo uses a dash
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
      if (!res.ok) throw Object.assign(new PriceError(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 100).replace(/\s+/g, ' ')}`), { fatal: true, status: res.status });
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

// Daily bars for one ticker from Yahoo Finance
async function fetchPrices(ticker, fromDay, toDay, opts = {}) {
  const rows = await fetchYahoo(ticker, fromDay, toDay, opts);
  if (!rows.length) throw new PriceError(`Yahoo: no rows for ${ticker}`);
  return rows;
}

// ---------- storage ----------
// One row per ticker with parallel arrays (day numbers since 1970, open, close, volume): about 15 KB for five years, so thousands
// of stocks cost tens of megabytes. High and low are not kept (nothing uses them).
const dayNum = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const dayIso = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

async function savePrices(pool, ticker, rows) {
  if (!rows.length) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [cur] } = await client.query('SELECT days, open, close, volume FROM bars WHERE ticker = $1 FOR UPDATE', [ticker]);
    const merged = new Map();
    if (cur) cur.days.forEach((d, i) => merged.set(d, [cur.open[i], cur.close[i], cur.volume[i]]));
    for (const r of rows) merged.set(dayNum(r.day), [r.open, r.close, r.volume]);
    const days = [...merged.keys()].sort((a, b) => a - b);
    await client.query(
      `INSERT INTO bars (ticker, days, open, close, volume, updated_at) VALUES ($1, $2::smallint[], $3::real[], $4::real[], $5::real[], now())
       ON CONFLICT (ticker) DO UPDATE SET days = EXCLUDED.days, open = EXCLUDED.open, close = EXCLUDED.close, volume = EXCLUDED.volume, updated_at = now()`,
      [ticker, days, days.map((d) => merged.get(d)[0]), days.map((d) => merged.get(d)[1]), days.map((d) => merged.get(d)[2])]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return rows.length;
}

// Rows per ticker: [{ day, open, close, volume }]
async function loadPrices(pool, tickers, { fromDay = '1900-01-01' } = {}) {
  const from = dayNum(fromDay);
  const { rows } = await pool.query('SELECT ticker, days, open, close, volume FROM bars WHERE ticker = ANY($1)', [tickers]);
  const out = new Map(tickers.map((t) => [t, []]));
  for (const r of rows) {
    const list = out.get(r.ticker);
    r.days.forEach((d, i) => { if (d >= from) list.push({ day: dayIso(d), open: r.open[i], close: r.close[i], volume: r.volume[i] }); });
  }
  return out;
}

// The same data as typed arrays (no per-row objects): { days: Int32Array of day numbers, open, close, volume: Float64Array }
async function loadBars(pool, tickers, { fromDay = '1900-01-01' } = {}) {
  const from = dayNum(fromDay);
  const { rows } = await pool.query('SELECT ticker, days, open, close, volume FROM bars WHERE ticker = ANY($1)', [tickers]);
  const out = new Map();
  for (const r of rows) {
    const keep = r.days.map((d, i) => (d >= from ? i : -1)).filter((i) => i >= 0);
    out.set(r.ticker, {
      days: Int32Array.from(keep, (i) => r.days[i]), open: Float64Array.from(keep, (i) => r.open[i]),
      close: Float64Array.from(keep, (i) => r.close[i]), volume: Float64Array.from(keep, (i) => r.volume[i]),
    });
  }
  return out;
}

module.exports = { fetchPrices, fetchYahoo, parseYahoo, savePrices, loadPrices, loadBars, dayNum, dayIso, yahooSymbol, getText, PriceError, BACKFILL_DAYS, FULL_REFRESH_DAYS, DAY_MS, isoDay, BROWSER_UA };
