// One-shot health probes of every external source, run from the server itself (so they show what the deployed
// service can actually reach). Single attempt, no retries, so the exact status is visible.
const { USER_AGENT } = require('./apewisdom');
const { BROWSER_UA } = require('./prices');

async function probe(source, url, check, { fetchImpl = fetch, headers = {} } = {}) {
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON: the check decides */ }
    const verdict = res.ok || res.status === 404 ? check(body, text, res.status) : null;
    return { source, ok: Boolean(verdict && verdict.ok), status: res.status, ms: Date.now() - started, detail: verdict ? verdict.detail : `HTTP ${res.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}` };
  } catch (err) {
    return { source, ok: false, status: null, ms: Date.now() - started, detail: `${err.name}: ${String(err.message).slice(0, 120)}${err.cause ? ` (${String(err.cause.code || err.cause.message).slice(0, 60)})` : ''}` };
  }
}

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10).replace(/-/g, '');

function probes(extra = []) {
  return [
    ['apewisdom', 'https://apewisdom.io/api/v1.0/filter/all-stocks/page/9', (b) => ({ ok: Array.isArray(b?.results), detail: `${b?.results?.length ?? 0} tickers on the last page` })],
    ['wikipedia-api', 'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1&titles=GameStop', (b) => ({ ok: Array.isArray(b?.query?.pages), detail: `resolved to ${b?.query?.pages?.[0]?.title}` })],
    ['wikimedia-pageviews', `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/GameStop/daily/${day(-5)}00/${day(-2)}00`, (b, t, s) => ({ ok: Array.isArray(b?.items) || s === 404, detail: s === 404 ? 'reachable (no data for that range)' : `${b.items.length} days returned, latest ${b.items[b.items.length - 1]?.views} views` })],
    ['yahoo-prices', `https://query1.finance.yahoo.com/v8/finance/chart/GME?interval=1d&range=5d`, (b) => ({ ok: Array.isArray(b?.chart?.result?.[0]?.timestamp), detail: b?.chart?.error ? `${b.chart.error.description}` : `${b?.chart?.result?.[0]?.timestamp?.length ?? 0} daily bars for GME` }), { headers: { 'User-Agent': BROWSER_UA } }],
    ['stooq-prices', 'https://stooq.com/q/d/l/?s=gme.us&i=d', (b, t) => ({ ok: t.startsWith('Date,'), detail: t.startsWith('Date,') ? `${t.trim().split('\n').length - 1} daily rows for GME` : t.trim().slice(0, 80) }), { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/csv,*/*' } }],
    ...extra,
  ];
}

async function runDiagnostics(extra = [], opts = {}) {
  const out = [];
  for (const [source, url, check, o] of probes(extra)) out.push(await probe(source, url, check, { ...opts, ...(o || {}) }));
  return out;
}

module.exports = { runDiagnostics, probe, probes };
