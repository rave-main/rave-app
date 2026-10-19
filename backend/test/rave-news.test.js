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

test('the job fetches six months for a new stock, only a month later, keeps what it had, and survives one rate-limit reply', async () => {
  await resetRave(pool);
  await seedHistory(pool, { GME: simulateCounts({ days: 2, level: 30, seed: 1 }), NEWS2: simulateCounts({ days: 2, level: 20, seed: 2 }) });
  await pool.query(`UPDATE tickers SET name = 'GameStop' WHERE ticker = 'GME'`);
  const g = fakeGdelt({ limitFirst: 1 });
  const first = await news.runNews(pool, { fetchImpl: g.fetchImpl, gapMs: 1, log: { log() {}, error() {} } });
  assert.deepEqual([first.fetched, first.errorCount], [2, 0]);
  assert.ok(g.calls.every((c) => c.span === '6months'));
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

test('the research export gives bars, page views, results dates and news per stock, paged', async () => {
  const { exportLab } = require('../src/rave/export');
  const prices = require('../src/rave/prices');
  const wiki = require('../src/rave/wiki');
  await resetRave(pool);
  await pool.query('DELETE FROM universe');
  await seedHistory(pool, { AAA: simulateCounts({ days: 2, level: 30, seed: 1 }) });
  const rows = Array.from({ length: 300 }, (_, i) => ({ day: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10), open: 10 + i * 0.5, close: 10.25 + i * 0.5, volume: 1000 + i }));
  await prices.savePrices(pool, 'AAA', rows);
  await prices.savePrices(pool, 'SPY', rows);
  await pool.query(`INSERT INTO wiki_pages (ticker, article, status, confidence, source) VALUES ('AAA', 'Triple A', 'resolved', 'high', 'auto')`);
  await wiki.saveViews(pool, 'Triple A', rows.slice(0, 100).map((r, i) => ({ day: r.day, views: 100 + i })));
  await pool.query(`INSERT INTO earnings_dates (ticker, day) VALUES ('AAA', '2025-02-01')`);
  await pool.query(`INSERT INTO news_months (ticker, month, tone, vol) VALUES ('AAA', '2025-01-01', $1, $2)`, [Array(31).fill(-1), Array(31).fill(0.002)]);
  const out = await exportLab(pool, { offset: 0, limit: 10 });
  assert.equal(out.total, 1);
  const a = out.stocks[0];
  assert.equal(a.bars.days.length, 300);
  assert.equal(a.bars.close[1], 10.75);
  assert.equal(a.viewsStart, '2025-01-01');
  assert.equal(a.views.length, 100);
  assert.deepEqual(a.earnings, ['2025-02-01']);
  assert.equal(a.news.tone.length, 31);
  assert.equal(out.spy.days.length, 300);
  assert.equal((await exportLab(pool, { offset: 1, limit: 10 })).stocks.length, 0);
});
