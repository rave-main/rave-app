// ApeWisdom adapter: Reddit stock-mention leaderboard. Everything that touches the network or the
// upstream response shape lives here, so a change in the service is a change in this one file.
// APEWISDOM_BASE_URL lets a local fake server stand in for the service (see docs/WORKLOG.md)
const BASE_URL = process.env.APEWISDOM_BASE_URL || 'https://apewisdom.io/api/v1.0';
const USER_AGENT = 'RAVE-research/1.0 (+https://github.com/rave-main/rave-app)';

const { displayName } = require('./text');

class ShapeError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Upstream sends some numbers as strings and uses null/"" for missing values
function toInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function parsePage(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.results)) {
    throw new ShapeError('response has no results array');
  }
  const rows = body.results.map((r, i) => {
    const ticker = typeof r?.ticker === 'string' ? r.ticker.trim().toUpperCase() : '';
    const rank = toInt(r?.rank);
    const mentions = toInt(r?.mentions);
    if (!ticker || rank === null || mentions === null) {
      throw new ShapeError(`result ${i} is missing ticker, rank or mentions`);
    }
    return {
      ticker,
      name: typeof r.name === 'string' ? displayName(r.name) : null,
      rank,
      mentions,
      upvotes: toInt(r.upvotes),
      rank24hAgo: toInt(r.rank_24h_ago),
      mentions24hAgo: toInt(r.mentions_24h_ago),
    };
  });
  return { rows, pages: toInt(body.pages) ?? 1 };
}

async function getJson(url, { fetchImpl, retries, timeoutMs, retryDelayMs }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs * 3 ** (attempt - 1));
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} from ${url}`);
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${url}`), { fatal: true });
      try {
        return await res.json();
      } catch {
        throw Object.assign(new ShapeError(`response from ${url} is not JSON`), { fatal: true });
      }
    } catch (err) {
      if (err.fatal) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

// Fetches every page of the leaderboard. A page that cannot be fetched fails the whole call: a partial
// leaderboard would make stocks look "not ranked" and corrupt the history.
async function fetchLeaderboard({
  filter = 'all-stocks',
  maxPages = 15,
  pageDelayMs = 750,
  retries = 3,
  timeoutMs = 15000,
  retryDelayMs = 1000,
  fetchImpl = fetch,
} = {}) {
  const options = { fetchImpl, retries, timeoutMs, retryDelayMs };
  const rows = [];
  const seen = new Set();
  const rawPages = [];
  let totalPages = 1;

  for (let page = 1; page <= Math.min(totalPages, maxPages); page++) {
    if (page > 1) await sleep(pageDelayMs);
    const body = await getJson(`${BASE_URL}/filter/${filter}/page/${page}`, options);
    const parsed = parsePage(body);
    totalPages = parsed.pages;
    rawPages.push({ page, payload: body });
    for (const row of parsed.rows) {
      if (!seen.has(row.ticker)) {
        seen.add(row.ticker);
        rows.push(row);
      }
    }
  }
  return { filter, totalPages, truncated: totalPages > maxPages, rows, rawPages };
}

module.exports = { fetchLeaderboard, parsePage, ShapeError, USER_AGENT };
