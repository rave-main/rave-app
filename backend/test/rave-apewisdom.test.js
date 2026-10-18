const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchLeaderboard, parsePage, ShapeError, USER_AGENT } = require('../src/rave/apewisdom');

const row = (rank, ticker, extra = {}) => ({
  rank, ticker, name: `${ticker} Inc`, mentions: 100 - rank, upvotes: 10, rank_24h_ago: rank + 1, mentions_24h_ago: 90 - rank, ...extra,
});
const body = (results, pages = 1, page = 1) => ({ count: 1000, pages, current_page: page, results });
const respond = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (data instanceof Error) throw data;
    return data;
  },
});
const fast = { pageDelayMs: 0, retryDelayMs: 1 };

test('parsePage converts string numbers, uppercases tickers and tolerates missing 24h fields', () => {
  const { rows, pages } = parsePage({
    pages: '3',
    results: [{ rank: '1', ticker: ' gme ', name: 'GameStop', mentions: '250', upvotes: '1200', rank_24h_ago: null, mentions_24h_ago: '' }],
  });
  assert.equal(pages, 3);
  assert.deepEqual(rows[0], {
    ticker: 'GME', name: 'GameStop', rank: 1, mentions: 250, upvotes: 1200, rank24hAgo: null, mentions24hAgo: null,
  });
});

test('parsePage rejects responses that do not match the documented shape', () => {
  assert.throws(() => parsePage(null), ShapeError);
  assert.throws(() => parsePage({ results: 'nope' }), ShapeError);
  assert.throws(() => parsePage({ results: [{ rank: 1, mentions: 5 }] }), ShapeError);
  assert.throws(() => parsePage({ results: [{ ticker: 'GME', rank: 1, mentions: 'many' }] }), ShapeError);
});

test('fetchLeaderboard pages through everything, identifies itself and de-duplicates tickers', async () => {
  const urls = [];
  const agents = [];
  const fetchImpl = async (url, opts) => {
    urls.push(url);
    agents.push(opts.headers['User-Agent']);
    return respond(url.endsWith('/page/1') ? body([row(1, 'GME'), row(2, 'AMC')], 2, 1) : body([row(2, 'AMC'), row(3, 'PLTR')], 2, 2));
  };
  const result = await fetchLeaderboard({ ...fast, fetchImpl });
  assert.deepEqual(urls, [
    'https://apewisdom.io/api/v1.0/filter/all-stocks/page/1',
    'https://apewisdom.io/api/v1.0/filter/all-stocks/page/2',
  ]);
  assert.deepEqual(agents, [USER_AGENT, USER_AGENT]);
  assert.deepEqual(result.rows.map((r) => r.ticker), ['GME', 'AMC', 'PLTR']);
  assert.equal(result.rawPages.length, 2);
  assert.equal(result.truncated, false);
});

test('fetchLeaderboard reports truncation when there are more pages than maxPages', async () => {
  const fetchImpl = async () => respond(body([row(1, 'GME')], 40));
  const result = await fetchLeaderboard({ ...fast, maxPages: 2, fetchImpl });
  assert.equal(result.rawPages.length, 2);
  assert.equal(result.truncated, true);
});

test('retries server errors and rate limits, then succeeds', async () => {
  const statuses = [503, 429, 200];
  let calls = 0;
  const fetchImpl = async () => {
    const status = statuses[calls++];
    return respond(status === 200 ? body([row(1, 'GME')]) : {}, status);
  };
  const result = await fetchLeaderboard({ ...fast, fetchImpl });
  assert.equal(calls, 3);
  assert.equal(result.rows.length, 1);
});

test('retries network errors and gives up after the retry budget', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw new Error('socket hang up');
  };
  await assert.rejects(fetchLeaderboard({ ...fast, retries: 2, fetchImpl }), /socket hang up/);
  assert.equal(calls, 3);
});

test('does not retry client errors or non-JSON bodies', async () => {
  let calls = 0;
  await assert.rejects(
    fetchLeaderboard({ ...fast, fetchImpl: async () => (calls++, respond({}, 404)) }),
    /HTTP 404/
  );
  assert.equal(calls, 1);
  await assert.rejects(
    fetchLeaderboard({ ...fast, fetchImpl: async () => respond(new SyntaxError('Unexpected token <')) }),
    ShapeError
  );
});

test('a failure on any later page fails the whole fetch instead of returning a partial leaderboard', async () => {
  const fetchImpl = async (url) => (url.endsWith('/page/1') ? respond(body([row(1, 'GME')], 2)) : respond({}, 500));
  await assert.rejects(fetchLeaderboard({ ...fast, retries: 1, fetchImpl }), /HTTP 500/);
});

test('names are stored as plain text: HTML entities decoded and fund-family prefixes dropped', () => {
  const { rows } = parsePage({
    pages: 1,
    results: [
      { rank: 1, ticker: 'VOO', name: 'Vanguard S&amp;P 500 ETF', mentions: 5 },
      { rank: 2, ticker: 'WH', name: 'Wyndham Hotels &amp; Resorts', mentions: 4 },
      { rank: 3, ticker: 'SPMO', name: 'Invesco Capital Management LLC - Invesco S&P 500 Momentum ETF', mentions: 3 },
      { rank: 4, ticker: 'JNJ', name: 'Johnson & Johnson', mentions: 2 },
    ],
  });
  assert.deepEqual(rows.map((r) => r.name), ['Vanguard S&P 500 ETF', 'Wyndham Hotels & Resorts', 'Invesco S&P 500 Momentum ETF', 'Johnson & Johnson']);
});
