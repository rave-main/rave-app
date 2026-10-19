const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, resetRave, seedHistory } = require('./helpers');
const prices = require('../src/rave/prices');
const { runPrices } = require('../src/rave/pricejob');
const { simulateCounts } = require('./rave-sim');

let pool;
before(async () => ({ pool } = await setup()));
after(() => pool.end());

const resp = (text, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text), headers: { get: () => null } });
const quiet = { log() {}, error() {} };

// ---- fixtures shaped like the real services ----
// Yahoo's timestamp is the market OPEN (14:30 UTC in summer); gmtoffset is the exchange's offset (-4h in summer)
function yahooBody(bars, { symbol = 'GME', error = null } = {}) {
  if (error) return JSON.stringify({ chart: { result: null, error } });
  return JSON.stringify({
    chart: {
      result: [{
        meta: { currency: 'USD', symbol, exchangeTimezoneName: 'America/New_York', gmtoffset: -14400 },
        timestamp: bars.map((b) => Date.parse(`${b.day}T13:30:00Z`) / 1000),
        indicators: {
          quote: [{ open: bars.map((b) => b.open ?? null), high: bars.map((b) => b.high ?? null), low: bars.map((b) => b.low ?? null), close: bars.map((b) => b.close ?? null), volume: bars.map((b) => b.volume ?? null) }],
          adjclose: [{ adjclose: bars.map((b) => b.adj ?? b.close ?? null) }],
        },
      }],
      error: null,
    },
  });
}
const bar = (day, n) => ({ day, open: 20 + n, high: 22 + n, low: 19 + n, close: 21 + n, volume: 1000 * (n + 1), adj: 20.5 + n });

test('parseYahoo reads daily bars, uses the exchange-local date, skips holidays and incomplete rows', () => {
  const body = yahooBody([bar('2026-10-12', 0), { day: '2026-10-13' }, bar('2026-10-14', 2), { day: '2026-10-15', open: 5, high: 6, low: 4, close: null }]);
  const rows = prices.parseYahoo(body, 'GME');
  assert.deepEqual(rows.map((r) => r.day), ['2026-10-12', '2026-10-14']);
  assert.deepEqual(rows[0], { day: '2026-10-12', open: 20, high: 22, low: 19, close: 21, adjClose: 20.5, volume: 1000 });
});

test('parseYahoo turns Yahoo error shapes and junk into clear errors', () => {
  assert.throws(() => prices.parseYahoo(yahooBody([], { error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } }), 'XYZ'), /No data found, symbol may be delisted \(XYZ\)/);
  assert.throws(() => prices.parseYahoo('<html>Too Many Requests</html>', 'GME'), /non-JSON/);
  assert.throws(() => prices.parseYahoo(JSON.stringify({ chart: { result: [{}] } }), 'GME'), /no price data/);
});

test('symbols with a class-share dot are written with a dash', () => {
  assert.equal(prices.yahooSymbol('BRK.B'), 'BRK-B');
  assert.equal(prices.yahooSymbol('gme'), 'GME');
});

test('Yahoo requests ask for the right range, and a Yahoo failure is reported clearly', async () => {
  const urls = [];
  const ok = async (url) => { urls.push(url); return resp(yahooBody([bar('2026-10-12', 0)])); };
  const rows = await prices.fetchPrices('GME', '2026-10-01', '2026-10-13', { fetchImpl: ok, retries: 0, retryDelayMs: 1 });
  assert.equal(rows.length, 1);
  assert.match(urls[0], /chart\/GME\?interval=1d&period1=1790812800&period2=1791936000/);
  await assert.rejects(prices.fetchPrices('GME', '2026-10-01', '2026-10-13', { fetchImpl: async () => resp('', 500), retries: 0, retryDelayMs: 1 }), /HTTP 500/);
  assert.equal('fetchStooq' in prices, false, 'Yahoo is the only price source');
});

test('retries 429 with backoff and fails fast on other client errors', async () => {
  let n = 0;
  const limited = async () => (++n < 3 ? resp('', 429) : resp(yahooBody([bar('2026-10-12', 0)])));
  const rows = await prices.fetchYahoo('GME', '2026-10-01', '2026-10-13', { fetchImpl: limited, retryDelayMs: 1 });
  assert.equal(rows.length, 1);
  assert.equal(n, 3);
  await assert.rejects(prices.fetchYahoo('GME', '2026-10-01', '2026-10-13', { fetchImpl: async () => resp('forbidden', 403), retryDelayMs: 1 }), /HTTP 403/);
});

test('savePrices upserts: re-saving corrects values without duplicating rows', async () => {
  await resetRave(pool);
  await prices.savePrices(pool, 'GME', [{ day: '2026-10-12', open: 1, high: 2, low: 1, close: 2, adjClose: 2, volume: 10 }], 'yahoo');
  await prices.savePrices(pool, 'GME', [{ day: '2026-10-12', open: 1, high: 3, low: 1, close: 2.5, adjClose: 2.5, volume: 12 }, { day: '2026-10-13', open: 2, high: 3, low: 2, close: 3, adjClose: 3, volume: 5 }], 'yahoo');
  const got = (await prices.loadPrices(pool, ['GME', 'XXX'])).get('GME');
  assert.equal(got.length, 2);
  assert.equal(got[0].close, 2.5);
  assert.equal(got[1].volume, 5);
  const bars = (await prices.loadBars(pool, ['GME'])).get('GME');
  assert.deepEqual([...bars.close], [2.5, 3]);
  assert.equal(prices.dayIso(bars.days[1]), '2026-10-13');
  assert.equal((await prices.loadPrices(pool, ['XXX'])).get('XXX').length, 0);
});

// ---- the job ----
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
function priceServer({ fail = [], dead = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const m = url.match(/chart\/([^?]+)\?.*period1=(\d+)&period2=(\d+)/);
    if (!m) return resp('', 404);
    const symbol = decodeURIComponent(m[1]);
    calls.push({ symbol, from: dayStr(Number(m[2]) * 1000), to: dayStr((Number(m[3]) - 86400) * 1000) });
    if (dead || fail.includes(symbol)) return resp(yahooBody([], { error: { code: 'Not Found', description: 'No data found' } }));
    const bars = [];
    for (let d = Number(m[2]) * 1000, n = 0; d <= (Number(m[3]) - 86400) * 1000; d += 86400000, n++) {
      const wd = new Date(d).getUTCDay();
      if (wd !== 0 && wd !== 6) bars.push(bar(dayStr(d), n % 5));
    }
    return resp(yahooBody(bars, { symbol }));
  };
  return { fetchImpl, calls };
}
const universeSeed = () => seedHistory(pool, { TSLA: simulateCounts({ days: 2, level: 30, seed: 1 }), GME: simulateCounts({ days: 2, level: 30, seed: 2 }) });
const run = (srv, now) => runPrices(pool, { fetchImpl: srv.fetchImpl, pauseMs: 0, log: quiet, now });

test('the price job backfills 5 years for the whole universe (benchmark first), then only tops up', async () => {
  await resetRave(pool);
  await universeSeed();
  const srv = priceServer();
  const t0 = Date.parse('2026-10-19T23:00:00Z');
  const first = await run(srv, t0);
  assert.equal(first.universe, 3, 'two stocks on the leaderboard plus the SPY benchmark');
  assert.equal(first.fetched, 3);
  assert.equal(first.fullRefreshes, 3);
  assert.equal(srv.calls[0].symbol, 'SPY', 'the benchmark goes first');
  assert.ok(srv.calls[0].from <= '2021-10-21' && srv.calls[0].from >= '2021-10-15', `backfill starts ${srv.calls[0].from}`);
  assert.ok(first.rowsAdded > 3 * 1200, `${first.rowsAdded} rows`);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM bars`)).rows[0].n, 3);

  const calls1 = srv.calls.length;
  const same = await run(srv, t0 + 30 * 60000); // 23:30 the same day
  assert.equal(same.skipped, 3, 'already synced through today: nothing to do');
  assert.equal(srv.calls.length, calls1);

  const next = await run(srv, t0 + 24 * 3600000); // the next day
  assert.equal(next.fetched, 3);
  assert.equal(next.fullRefreshes, 0, 'a top-up, not a full refresh');
  const c = srv.calls[calls1];
  assert.ok(c.from >= '2026-10-08' && c.from <= '2026-10-10', `top-up overlaps the last 10 days: from ${c.from}`);
  assert.equal(c.to, '2026-10-20');
});

test('a full refresh is repeated weekly (splits rewrite history)', async () => {
  await resetRave(pool);
  await universeSeed();
  const srv = priceServer();
  const t0 = Date.parse('2026-10-19T23:00:00Z');
  await run(srv, t0);
  const weekLater = await run(srv, t0 + 8 * 24 * 3600000);
  assert.equal(weekLater.fullRefreshes, 3);
});

test('one failing ticker is recorded and skipped; mostly failing fails the whole run', async () => {
  await resetRave(pool);
  await universeSeed();
  const some = await run(priceServer({ fail: ['GME'] }), Date.parse('2026-10-19T23:00:00Z'));
  assert.equal(some.notFound, 1, 'a symbol Yahoo does not know is counted, not treated as an outage');
  assert.equal(some.errorCount, 0);
  assert.equal(some.fetched, 2);
  const { rows: [s] } = await pool.query(`SELECT error FROM price_sync WHERE ticker = 'GME'`);
  assert.match(s.error, /not found: .*No data found/);

  await resetRave(pool);
  await universeSeed();
  await assert.rejects(run(priceServer({ dead: true }), Date.parse('2026-10-19T23:00:00Z')), /Price fetches failing \(3 of 3 tickers\)/);

  // a ticker Yahoo rejected is not asked again on every run: it waits a few days
  await resetRave(pool);
  await universeSeed();
  const srv = priceServer({ fail: ['GME'] });
  const t0 = Date.parse('2026-10-19T23:00:00Z');
  await run(srv, t0);
  srv.calls.length = 0;
  await run(srv, t0 + 24 * 3600000);
  assert.ok(!srv.calls.some((c) => c.symbol === 'GME'), 'GME is not retried the next day');
  srv.calls.length = 0;
  await run(srv, t0 + 4 * 24 * 3600000);
  assert.ok(!srv.calls.some((c) => c.symbol === 'GME'), 'a symbol Yahoo does not know waits much longer than three days');
  srv.calls.length = 0;
  await run(srv, t0 + 31 * 24 * 3600000);
  assert.ok(srv.calls.some((c) => c.symbol === 'GME'), 'but it is asked again after a month');
});

test('a ticker with no history yet is synced before ones that only need a top-up', async () => {
  await resetRave(pool);
  await universeSeed();
  const srv = priceServer();
  const t0 = Date.parse('2026-10-19T23:00:00Z');
  await run(srv, t0);
  await pool.query(`DELETE FROM price_sync WHERE ticker = 'TSLA'`);
  srv.calls.length = 0;
  await run(srv, t0 + 24 * 3600000);
  assert.equal(srv.calls[0].symbol, 'SPY');
  assert.equal(srv.calls[1].symbol, 'TSLA', 'the unsynced ticker comes right after the benchmark');
});
