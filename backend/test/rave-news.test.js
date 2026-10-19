const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, resetRave, seedHistory } = require('./helpers');
const { simulateCounts } = require('./rave-sim');
const news = require('../src/rave/news');

let pool;
before(async () => ({ pool } = await setup()));
after(() => pool.end());

test('the query uses the company name with finance words, English only', () => {
  assert.equal(news.newsQuery('Tesla, Inc.'), '"Tesla" (stock OR shares OR earnings OR stocks) sourcelang:english');
  assert.equal(news.newsQuery('Meta Platforms (Facebook)'), '"Meta Platforms" (stock OR shares OR earnings OR stocks) sourcelang:english');
  assert.equal(news.newsQuery('GameStop'), '"GameStop" (stock OR shares OR earnings OR stocks) sourcelang:english');
});

test('points become one value per day (the mean of the points in the day)', () => {
  const m = news.perDay([{ date: '20251001T000000Z', value: 1 }, { date: '20251001T120000Z', value: 3 }, { date: '20251002T000000Z', value: -2 }, { date: 'bad', value: 5 }, { date: '20251003T000000Z', value: NaN }]);
  assert.deepEqual([...m], [['2025-10-01', 2], ['2025-10-02', -2]]);
});

function fakeGdelt({ limitFirst = 0, empty = [] } = {}) {
  const calls = [];
  let limited = limitFirst;
  const fetchImpl = async (url) => {
    const q = decodeURIComponent(url.match(/query=([^&]+)/)[1]);
    const mode = url.match(/mode=([^&]+)/)[1];
    const span = url.match(/timespan=([^&]+)/)[1];
    calls.push({ q, mode, span });
    if (limited > 0) { limited--; return { ok: false, status: 429, text: async () => 'Please limit requests to one every 5 seconds' }; }
    if (empty.some((e) => q.includes(e))) return { ok: true, status: 200, text: async () => '' };
    const data = Array.from({ length: 5 }, (_, i) => ({ date: `2026-10-0${i + 1}`.replace(/-/g, '') + 'T000000Z', value: mode === 'timelinetone' ? -1 + i : 0.001 * (i + 1) }));
    return { ok: true, status: 200, text: async () => JSON.stringify({ timeline: [{ series: mode, data }] }) };
  };
  return { fetchImpl, calls };
}

test('the job fetches a year for a new stock, only a month later, keeps what it had, and survives one rate-limit reply', async () => {
  await resetRave(pool);
  await seedHistory(pool, { GME: simulateCounts({ days: 2, level: 30, seed: 1 }), NEWS2: simulateCounts({ days: 2, level: 20, seed: 2 }) });
  await pool.query(`UPDATE tickers SET name = 'GameStop' WHERE ticker = 'GME'`);
  const g = fakeGdelt({ limitFirst: 1 });
  const first = await news.runNews(pool, { fetchImpl: g.fetchImpl, gapMs: 1, log: { log() {}, error() {} } });
  assert.deepEqual([first.fetched, first.errorCount], [2, 0]);
  assert.ok(g.calls.every((c) => c.span === '1y'));
  assert.equal(g.calls.length, 5, 'two requests for each stock plus the retried one');
  const rows = (await news.loadNews(pool, ['GME'])).get('GME');
  assert.equal(rows.length, 5);
  assert.deepEqual([rows[0].day, rows[0].tone, rows[4].tone], ['2026-10-01', -1, 3]);
  assert.ok(Math.abs(rows[0].vol - 0.001) < 1e-6);
  assert.equal((await news.runNews(pool, { fetchImpl: g.fetchImpl, gapMs: 1 })).due, 0);
  const g2 = fakeGdelt();
  const later = await news.runNews(pool, { fetchImpl: g2.fetchImpl, gapMs: 1, now: Date.now() + 21 * 3600000 });
  assert.equal(later.fetched, 2);
  assert.ok(g2.calls.every((c) => c.span === '1month'), 'a top-up asks for a month, not a year');
  assert.equal((await news.loadNews(pool, ['GME'])).get('GME').length, 5);
});

test('no matching articles is not an error, and a source that keeps failing fails the run clearly', async () => {
  await resetRave(pool);
  await seedHistory(pool, { GME: simulateCounts({ days: 2, level: 30, seed: 1 }) });
  await pool.query(`UPDATE tickers SET name = 'GameStop' WHERE ticker = 'GME'`);
  const none = await news.runNews(pool, { fetchImpl: fakeGdelt({ empty: ['GameStop'] }).fetchImpl, gapMs: 1 });
  assert.equal(none.fetched, 1);
  await resetRave(pool);
  await seedHistory(pool, { GME: simulateCounts({ days: 2, level: 30, seed: 1 }) });
  await assert.rejects(news.runNews(pool, { fetchImpl: async () => { throw new Error('connection reset'); }, gapMs: 1 }), /GDELT news failing/);
});
