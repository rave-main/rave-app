const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, signedInAgent, request, resetRave, seedHistory } = require('./helpers');
const wiki = require('../src/rave/wiki');
const prices = require('../src/rave/prices');
const research = require('../src/rave/research');
const { world } = require('./validation-world');
const { simulate, HOUR } = require('./rave-sim');
const { scoredStocks } = require('../src/rave/tracked');

let pool, app;
before(async () => ({ pool, app } = await setup()));
after(() => pool.end());

const quiet = { log() {}, error() {} };
const toPriceRows = (rows) => rows.map((r) => ({ day: r.day, open: r.open, high: Math.max(r.open, r.close), low: Math.min(r.open, r.close), close: r.close, adjClose: r.close, volume: r.volume }));

async function seedWorld(w, { shareArticle = false } = {}) {
  await prices.savePrices(pool, 'SPY', toPriceRows(w.bench), 'yahoo');
  for (let i = 0; i < w.series.length; i++) {
    const s = w.series[i];
    const ticker = `W${i}`;
    const article = `Article ${i}`;
    await pool.query(`INSERT INTO tickers (ticker, name, first_seen, last_seen, fetched_at, ranked, mentions) VALUES ($1, $2, now(), now(), now(), true, 10)`, [ticker, `Company ${i}`]);
    await pool.query(`INSERT INTO wiki_pages (ticker, article, status, confidence, source) VALUES ($1, $2, 'resolved', 'high', 'auto')`, [ticker, article]);
    const start = Date.parse(`${s.startDay}T00:00:00Z`);
    await wiki.saveViews(pool, article, s.values.map((views, k) => ({ day: new Date(start + k * 86400000).toISOString().slice(0, 10), views })));
    await prices.savePrices(pool, ticker, toPriceRows(s.prices), 'yahoo');
  }
  if (shareArticle) { // GOOGL-style: a second ticker for the same article and prices
    await pool.query(`INSERT INTO tickers (ticker, name, first_seen, last_seen, fetched_at, ranked, mentions) VALUES ('W0B', 'Company 0 class B', now(), now(), now(), true, 5)`);
    await pool.query(`INSERT INTO wiki_pages (ticker, article, status, confidence, source) VALUES ('W0B', 'Article 0', 'resolved', 'high', 'auto')`);
    await prices.savePrices(pool, 'W0B', toPriceRows(w.series[0].prices), 'yahoo');
  }
}

test('the backtest finds a built-in volatility effect on real tables, counts a shared article once, and stores the result', async () => {
  await resetRave(pool);
  await seedWorld(world({ seed: 21, tickers: 12, effect: { volMult: 2.5, lag: 2 } }), { shareArticle: true });
  const out = await research.runResearch(pool, { B: 150, log: quiet });
  assert.equal(out.status, 'ok');
  assert.equal(out.tickers, 12, 'the duplicate-article ticker is not a thirteenth series');
  assert.equal(out.verdict, 'size');
  const { rows: [row] } = await pool.query(`SELECT results FROM validation_runs WHERE kind = 'wiki_backtest'`);
  const r = row.results;
  assert.equal(r.universe.tickers, 12);
  assert.ok(!r.universe.list.some((u) => u.ticker === 'W0B'));
  assert.ok(r.conservative.results[5].size.p < 0.02, `p ${r.conservative.results[5].size.p}`);
  assert.ok(r.conservative.results[5].size.mean > 0.003);
  assert.equal(r.conservative.lagDays, 2);
  assert.equal(r.optimistic.lagDays, 1);
  assert.equal(r.leadLag.length, 21);
  assert.equal(r.verdict.conservative.level, 'size');
  assert.ok(r.caveats.length >= 3 && r.caveats.some((c) => /popular today/.test(c)), 'the selection-bias caveat is stored with the result');
  assert.ok(r.universe.firstDay <= '2023-01-02');
});

test('with too little data the backtest says so (and stores that), rather than inventing a result', async () => {
  await resetRave(pool);
  const out = await research.runResearch(pool, { B: 50, log: quiet });
  assert.equal(out.status, 'insufficient');
  assert.match(out.reason, /at least 8 stocks/);
  const { rows: [row] } = await pool.query(`SELECT results FROM validation_runs`);
  assert.equal(row.results.status, 'insufficient');
});

test('entry rule: before 13:30 UTC the same day\'s open, otherwise the next day (never an open that has already happened)', () => {
  assert.equal(research.entryCandidateDay('2026-10-19T10:00:00Z'), '2026-10-19');
  assert.equal(research.entryCandidateDay('2026-10-19T13:29:59Z'), '2026-10-19');
  assert.equal(research.entryCandidateDay('2026-10-19T13:30:00Z'), '2026-10-20');
  assert.equal(research.entryCandidateDay('2026-10-19T21:00:00Z'), '2026-10-20');
});

// ---- ledger ----
const recentMonday = () => { const d = new Date(Date.now() - 45 * 86400000); d.setUTCHours(0, 0, 0, 0); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() - 1); return d.getTime(); };
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
function weekdayRows(fromMs, n, f) {
  const rows = [];
  for (let d = fromMs, i = 0; rows.length < n; d += 86400000) {
    const wd = new Date(d).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    rows.push({ day: isoDay(d), open: f.open(i), high: 99, low: 1, close: f.close(i), adjClose: f.close(i), volume: 1e6 });
    i++;
  }
  return rows;
}
const addEvent = (ticker, at) => pool.query(`INSERT INTO spike_events (ticker, detected_at, label, ratio, z, mentions, baseline) VALUES ($1, $2, 'Hot', 3, 4, 40, 10)`, [ticker, at]);

test('ledger: entry at the next open after detection, outcomes computed against SPY and filled in as prices arrive', async () => {
  await resetRave(pool);
  const mon = recentMonday();
  // GME: open 10+i, close 10.5+i (so day-1 return is +5%); SPY flat
  await prices.savePrices(pool, 'GME', weekdayRows(mon - 40 * 86400000, 60, { open: (i) => 10 + i, close: (i) => 10.5 + i }), 'yahoo');
  await prices.savePrices(pool, 'SPY', weekdayRows(mon - 40 * 86400000, 60, { open: () => 100, close: () => 100 }), 'yahoo');
  const before = new Date(mon + 10 * 3600000); // Monday 10:00 UTC: before the open
  const after = new Date(mon + 15 * 3600000); // Monday 15:00 UTC: after the open
  const saturday = new Date(mon - 2 * 86400000 + 10 * 3600000);
  await addEvent('GME', before);
  await addEvent('GME', after);
  await addEvent('GME', saturday);
  assert.equal((await research.updateLedger(pool)).updated, 3);

  const { rows } = await pool.query(`SELECT detected_at, entry_day::text AS entry_day, entry_open, outcomes FROM spike_events ORDER BY id`);
  assert.equal(rows[0].entry_day, isoDay(mon), 'detected before the open: that day');
  assert.equal(rows[1].entry_day, isoDay(mon + 86400000), 'detected after the open: the next trading day');
  assert.equal(rows[2].entry_day, isoDay(mon), 'detected on a Saturday: Monday');
  const idx = (await prices.loadPrices(pool, ['GME'])).get('GME').map((r) => r.day);
  const e0 = idx.indexOf(rows[0].entry_day);
  assert.equal(rows[0].entry_open, 10 + e0);
  const day1 = rows[0].outcomes['1'];
  assert.ok(Math.abs(day1.ret - (10.5 + e0) / (10 + e0) + 1) < 1e-9, 'one day: open to that day\'s close');
  assert.ok(Math.abs(day1.abn - day1.ret) < 1e-12, 'SPY is flat, so abnormal = raw');
  const day5 = rows[0].outcomes['5'];
  assert.ok(Math.abs(day5.ret - ((10.5 + e0 + 4) / (10 + e0) - 1)) < 1e-9, 'five days: open of day 1 to close of day 5');
  assert.ok(rows[0].outcomes['20'], 'twenty trading days have passed too');
});

test('ledger: a recent spike only has the short outcomes until more prices arrive, and is then completed', async () => {
  await resetRave(pool);
  const mon = recentMonday() + 28 * 86400000; // four weeks later: a Monday about 17 days ago
  const rows = weekdayRows(mon - 90 * 86400000, 100, { open: (i) => 50 + i * 0.1, close: (i) => 50.2 + i * 0.1 });
  const lastDay = rows.findIndex((r) => r.day === isoDay(mon));
  await prices.savePrices(pool, 'GME', rows.slice(0, lastDay + 3), 'yahoo'); // prices only up to 2 trading days after the spike
  await prices.savePrices(pool, 'SPY', rows.slice(0, lastDay + 3).map((r) => ({ ...r, open: 100, close: 100 })), 'yahoo');
  await addEvent('GME', new Date(mon + 9 * 3600000));
  await research.updateLedger(pool);
  let ev = (await pool.query('SELECT outcomes FROM spike_events')).rows[0];
  assert.deepEqual(Object.keys(ev.outcomes).sort(), ['1']);
  assert.deepEqual((await research.updateLedger(pool)), { updated: 0 }, 'nothing new: no needless rewrite');

  await prices.savePrices(pool, 'GME', rows.slice(0, lastDay + 8), 'yahoo');
  await prices.savePrices(pool, 'SPY', rows.slice(0, lastDay + 8).map((r) => ({ ...r, open: 100, close: 100 })), 'yahoo');
  assert.equal((await research.updateLedger(pool)).updated, 1);
  ev = (await pool.query('SELECT outcomes FROM spike_events')).rows[0];
  assert.deepEqual(Object.keys(ev.outcomes).sort(), ['1', '5']);
});

test('recordSpikes notes a confirmed Hot/Extreme stock once, not again within 7 days, and ignores quiet ones', async () => {
  await resetRave(pool);
  const grid = simulate({ days: 40, seed: 21 });
  const surge = simulate({ days: 40, seed: 21, multiplier: (t) => (t > grid[grid.length - 1].t - 36 * HOUR ? 5 : 1) });
  await seedHistory(pool, { GME: surge, TSLA: grid });
  const stocks = await scoredStocks(pool);
  assert.ok(['Hot', 'Extreme'].includes(stocks.find((s) => s.ticker === 'GME').scores.short.label));
  assert.equal(await research.recordSpikes(pool), 1);
  assert.equal(await research.recordSpikes(pool), 0, 'cool-down of 7 days');
  const { rows } = await pool.query('SELECT ticker, label, ratio, z, mentions, explanation FROM spike_events');
  assert.deepEqual(rows.map((r) => r.ticker), ['GME']);
  assert.ok(rows[0].ratio > 2 && rows[0].z > 3);
  assert.match(rows[0].explanation, /^GME: /);
});

test('ledger summary reports averages per horizon and the progress towards a meaningful sample', async () => {
  await resetRave(pool);
  const o = (abn) => ({ ret: abn, abn, absAbn: Math.abs(abn), vol: 1.2 });
  const ins = (abn5) => pool.query(`INSERT INTO spike_events (ticker, detected_at, label, ratio, z, mentions, baseline, entry_day, outcomes) VALUES ('GME', now() - interval '3 days', 'Hot', 3, 4, 40, 10, current_date, $1)`, [JSON.stringify({ 1: o(abn5 / 2), 5: o(abn5) })]);
  await ins(0.04); await ins(-0.02); await ins(0.03);
  await pool.query(`INSERT INTO spike_events (ticker, detected_at, label, ratio, z, mentions, baseline) VALUES ('AMC', now(), 'Hot', 3, 4, 40, 10)`);
  const s = await research.ledgerSummary(pool);
  assert.equal(s.total, 4);
  assert.equal(s.withFiveDayOutcome, 3);
  assert.equal(s.needed, 30);
  assert.ok(Math.abs(s.progress - 0.1) < 1e-9);
  assert.ok(Math.abs(s.perHorizon[5].meanAbnormal - 0.01667) < 1e-4);
  assert.ok(Math.abs(s.perHorizon[5].hitRate - 2 / 3) < 1e-9);
  assert.equal(s.perHorizon[20].n, 0);
});

test('research endpoint requires sign-in and returns the backtest (or null) with the ledger', async () => {
  await resetRave(pool);
  await request(app).get('/api/rave/research').expect(401);
  const { agent } = await signedInAgent(app);
  let { body } = await agent.get('/api/rave/research').expect(200);
  assert.equal(body.backtest, null);
  assert.equal(body.ledger.total, 0);
  await research.runResearch(pool, { B: 20, log: quiet }); // stores an "insufficient" run
  ({ body } = await agent.get('/api/rave/research').expect(200));
  assert.equal(body.backtest.status, 'insufficient');
});

test('the Wikipedia forward ledger records an Extreme page-view spike once per 10 days, bought two days after the spike day', async () => {
  await resetRave(pool);
  const grid = simulate({ days: 12, seed: 5 });
  await seedHistory(pool, { WIKI1: grid.map((p) => ({ ...p, mentions: 20 })) });
  await pool.query(`INSERT INTO wiki_pages (ticker, article, status, confidence, source) VALUES ('WIKI1', 'Wiki One', 'resolved', 'high', 'auto')`);
  const day = (k) => new Date(Date.now() - k * 86400000).toISOString().slice(0, 10);
  // 80 ordinary days around 1,000 views, then a jump to 6,000 on the latest full day
  await wiki.saveViews(pool, 'Wiki One', Array.from({ length: 80 }, (_, i) => ({ day: day(80 - i), views: i === 79 ? 6000 : 1000 + (i % 5) * 20 })));
  const stocks = await scoredStocks(pool);
  assert.equal(stocks.find((s) => s.ticker === 'WIKI1').wiki.scores.short.label, 'Extreme');
  assert.equal(await research.recordSpikes(pool), 1);
  assert.equal(await research.recordSpikes(pool), 0, 'cool-down of 10 days');
  const { rows } = await pool.query(`SELECT source, label, mentions FROM spike_events`);
  assert.deepEqual(rows.map((r) => [r.source, r.label, r.mentions]), [['wiki', 'Extreme', 6000]]);
  assert.equal(research.entryCandidateDay('2026-10-14T05:00:00Z', 'wiki'), '2026-10-15');
  assert.equal((await research.ledgerSummary(pool, 'wiki')).total, 1);
  assert.equal((await research.ledgerSummary(pool, 'reddit')).total, 0);
});
