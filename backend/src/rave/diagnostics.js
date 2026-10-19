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
    ...extra,
  ];
}

// Sources we may add (earnings dates, news, Reddit history, index lists). Probed on request so a new source can be judged from the deployed
// service before any code depends on it: /api/rave/diagnostics?candidates=1
const SEC_UA = 'RAVE research (https://github.com/rave-main/rave-app) rave-research@example.com';
function candidateProbes() {
  const sec = { headers: { 'User-Agent': SEC_UA, Accept: 'application/json' } };
  return [
    ['sec-submissions', 'https://data.sec.gov/submissions/CIK0001326380.json', (b) => ({ ok: Array.isArray(b?.filings?.recent?.form), detail: `${b?.filings?.recent?.form?.length ?? 0} recent filings, ${b?.filings?.recent?.items?.filter((i) => /2\.02/.test(i)).length ?? 0} with item 2.02 (results)` }), sec],
    ['sec-company-tickers', 'https://www.sec.gov/files/company_tickers.json', (b) => ({ ok: b && Object.keys(b).length > 1000, detail: `${b ? Object.keys(b).length : 0} companies` }), sec],
    ['gdelt-news-tone', 'https://api.gdeltproject.org/api/v2/doc/doc?query=GameStop%20sourcelang%3Aenglish&mode=timelinetone&format=json&timespan=1y', (b) => ({ ok: Array.isArray(b?.timeline), detail: `${b?.timeline?.[0]?.data?.length ?? 0} points of news tone` })],
    ['gdelt-news-volume', 'https://api.gdeltproject.org/api/v2/doc/doc?query=GameStop%20sourcelang%3Aenglish&mode=timelinevolraw&format=json&timespan=1y', (b) => ({ ok: Array.isArray(b?.timeline), detail: `${b?.timeline?.[0]?.data?.length ?? 0} points of article counts` })],
    ['google-news-rss', 'https://news.google.com/rss/search?q=GameStop+stock&hl=en-US&gl=US&ceid=US:en', (b, t) => ({ ok: /<item>/.test(t), detail: `${(t.match(/<item>/g) || []).length} headlines` })],
    ['yahoo-news-rss', 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=GME&region=US&lang=en-US', (b, t) => ({ ok: /<item>/.test(t), detail: `${(t.match(/<item>/g) || []).length} headlines` })],
    ['nasdaq-earnings', 'https://api.nasdaq.com/api/calendar/earnings?date=2026-10-15', (b) => ({ ok: Array.isArray(b?.data?.rows), detail: `${b?.data?.rows?.length ?? 0} companies reporting` }), { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } }],
    ['yahoo-calendar', 'https://query2.finance.yahoo.com/v10/finance/quoteSummary/GME?modules=calendarEvents', (b) => ({ ok: Boolean(b?.quoteSummary?.result), detail: b?.quoteSummary?.error ? b.quoteSummary.error.description : 'calendar found' }), { headers: { 'User-Agent': BROWSER_UA } }],
    ['arctic-shift-reddit', 'https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=wallstreetbets&limit=1&sort=asc', (b) => ({ ok: Array.isArray(b?.data), detail: `${b?.data?.length ?? 0} posts, oldest ${b?.data?.[0]?.created_utc ? new Date(b.data[0].created_utc * 1000).toISOString().slice(0, 10) : '?'}` })],
    ['wikipedia-sp500-list', 'https://en.wikipedia.org/w/api.php?action=parse&page=List_of_S%26P_500_companies&prop=sections&format=json&formatversion=2', (b) => ({ ok: Array.isArray(b?.parse?.sections), detail: `${b?.parse?.sections?.length ?? 0} sections` })],
    ['wikipedia-sp400-list', 'https://en.wikipedia.org/w/api.php?action=parse&page=List_of_S%26P_400_companies&prop=sections&format=json&formatversion=2', (b) => ({ ok: Array.isArray(b?.parse?.sections), detail: `${b?.parse?.sections?.length ?? 0} sections` })],
    ['stooq', 'https://stooq.com/q/d/l/?s=gme.us&i=d', (b, t) => ({ ok: t.startsWith('Date,'), detail: t.startsWith('Date,') ? 'reachable' : t.slice(0, 60) })],
  ];
}

// Round two: retries with what round one taught us (SEC wants a contact in the user agent; GDELT allows one request every 5 seconds;
// Yahoo wants a cookie and crumb; Arctic Shift may offer daily counts)
function candidateProbes2() {
  const sec2 = { headers: { 'User-Agent': 'RAVE Research rave-main@users.noreply.github.com', 'Accept-Encoding': 'gzip, deflate', Host: 'data.sec.gov' } };
  return [
    ['sec-submissions-2', 'https://data.sec.gov/submissions/CIK0001326380.json', (b) => ({ ok: Array.isArray(b?.filings?.recent?.form), detail: `${b?.filings?.recent?.form?.length ?? 0} recent filings` }), sec2],
    ['sec-efts-search', 'https://efts.sec.gov/LATEST/search-index?q=%22results%20of%20operations%22&forms=8-K&dateRange=custom&startdt=2026-10-01&enddt=2026-10-15', (b) => ({ ok: Boolean(b?.hits), detail: `${b?.hits?.total?.value ?? 0} hits` }), { headers: { 'User-Agent': 'RAVE Research rave-main@users.noreply.github.com' } }],
    ['arctic-aggregate', 'https://arctic-shift.photon-reddit.com/api/comments/search/aggregate?subreddit=wallstreetbets&body=GME&aggregate=created_utc&frequency=month&after=2024-01-01&before=2024-04-01', (b) => ({ ok: Array.isArray(b?.data), detail: `${b?.data?.length ?? 0} buckets: ${JSON.stringify(b?.data?.slice(0, 3))}` })],
    ['arctic-posts-count', 'https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=wallstreetbets&limit=100&after=2025-03-03&before=2025-03-04&fields=title,created_utc,score,num_comments', (b) => ({ ok: Array.isArray(b?.data), detail: `${b?.data?.length ?? 0} posts in one day (limit 100)` })],
    ['yahoo-cookie', 'https://fc.yahoo.com/', (b, t, s) => ({ ok: s === 404 || s === 200, detail: `status ${s}` }), { headers: { 'User-Agent': BROWSER_UA } }],
  ];
}

// Round three: Yahoo can return earnings dates as chart events, and with a cookie and crumb the quote-summary calendar works
function candidateProbes3() {
  return [
    ['yahoo-chart-earnings', 'https://query1.finance.yahoo.com/v8/finance/chart/GME?range=5y&interval=1d&events=earn', (b) => {
      const e = b?.chart?.result?.[0]?.events;
      const n = e?.earnings ? Object.keys(e.earnings).length : 0;
      return { ok: n > 0, detail: `${n} earnings events; event kinds: ${e ? Object.keys(e).join(',') : 'none'}; sample ${n ? JSON.stringify(Object.values(e.earnings)[0]).slice(0, 120) : ''}` };
    }, { headers: { 'User-Agent': BROWSER_UA } }],
    ['yahoo-chart-earnings-aapl', 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5y&interval=1d&events=earn%2Cdiv%2Csplit', (b) => {
      const e = b?.chart?.result?.[0]?.events;
      const n = e?.earnings ? Object.keys(e.earnings).length : 0;
      return { ok: n > 0, detail: `${n} earnings events; kinds ${e ? Object.keys(e).join(',') : 'none'}` };
    }, { headers: { 'User-Agent': BROWSER_UA } }],
    ['arctic-aggregate-small', 'https://arctic-shift.photon-reddit.com/api/posts/search/aggregate?subreddit=wallstreetbets&title=GME&aggregate=created_utc&frequency=week&after=2025-01-01&before=2025-02-01', (b) => ({ ok: Array.isArray(b?.data), detail: `${b?.data?.length ?? 0} buckets ${JSON.stringify(b?.data?.slice(0, 3))} ${b?.error || ''}` })],
    ['gdelt-tone-queries', 'https://api.gdeltproject.org/api/v2/doc/doc?query=%22GameStop%22%20sourcelang%3Aenglish&mode=timelinetone&format=json&timespan=3y', (b) => ({ ok: Array.isArray(b?.timeline), detail: `${b?.timeline?.[0]?.data?.length ?? 0} points over 3y; first ${JSON.stringify(b?.timeline?.[0]?.data?.[0])}` })],
  ];
}

async function runDiagnostics(extra = [], opts = {}) {
  const out = [];
  for (const [source, url, check, o] of probes(extra)) out.push(await probe(source, url, check, { ...opts, ...(o || {}) }));
  return out;
}

module.exports = { runDiagnostics, probe, probes, candidateProbes, candidateProbes2, candidateProbes3 };
