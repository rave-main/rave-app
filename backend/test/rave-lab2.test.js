const { test } = require('node:test');
const assert = require('node:assert/strict');
const lab = require('../src/rave/lab2');
const { makeRng } = require('../src/rave/validation');

const DAY0 = Math.round(Date.parse('2021-10-04T00:00:00Z') / 86400000); // a Monday
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

// A synthetic market of `n` stocks over about 5 years. `persistence` > 0 makes each stock's drift last for months (so past returns predict future ones).
function market({ n = 60, sessions = 1250, seed = 1, driftSd = 0, rho = 0.99 }) {
  const r = makeRng(seed);
  const days = [];
  for (let d = DAY0; days.length < sessions; d++) { const w = new Date(d * 86400000).getUTCDay(); if (w !== 0 && w !== 6) days.push(d); }
  const mkt = days.map(() => 0.0003 + 0.009 * gauss(r));
  let m = 100;
  const spy = { days: Int32Array.from(days), open: new Float64Array(sessions), close: new Float64Array(sessions) };
  for (let i = 0; i < sessions; i++) { spy.open[i] = m * (1 + 0.3 * mkt[i]); m *= 1 + mkt[i]; spy.close[i] = m; }
  const stocks = [];
  for (let s = 0; s < n; s++) {
    const vol = 0.012 + 0.02 * r();
    let mu = 0, px = 50;
    const open = new Float64Array(sessions), close = new Float64Array(sessions), volume = new Float64Array(sessions);
    for (let i = 0; i < sessions; i++) {
      mu = rho * mu + driftSd * gauss(r);
      const ret = mkt[i] + mu + vol * gauss(r);
      open[i] = px * (1 + 0.3 * ret); px *= 1 + ret; close[i] = px;
      volume[i] = 1e6 * Math.exp(0.2 * gauss(r)) * (r() < 0.01 ? 5 : 1);
    }
    const values = Array.from({ length: days[sessions - 1] - days[0] + 1 }, () => Math.round(1000 * Math.exp(0.2 * gauss(r))));
    stocks.push({ ticker: `S${s}`, addedDay: null, removedDay: null, bars: { days: Int32Array.from(days), open, close, volume }, views: { start: days[0], values }, news: null });
  }
  return { stocks, spy };
}

test('the area under the curve is 1 for a perfect score, about 0.5 for noise, and handles ties', () => {
  assert.equal(lab.auc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]), 1);
  assert.equal(lab.auc([0, 0, 1, 1], [0.9, 0.8, 0.2, 0.1]), 0);
  assert.equal(lab.auc([0, 1], [0.5, 0.5]), 0.5);
  assert.equal(lab.auc([1, 1], [0.1, 0.2]), null);
  const r = makeRng(3);
  const y = Array.from({ length: 4000 }, () => (r() < 0.3 ? 1 : 0));
  assert.ok(Math.abs(lab.auc(y, y.map(() => r())) - 0.5) < 0.03);
});

test('logistic regression finds the direction of the effect and ignores a useless input', () => {
  const r = makeRng(4);
  const n = 5000;
  const x1 = Float64Array.from({ length: n }, () => gauss(r)), x2 = Float64Array.from({ length: n }, () => gauss(r));
  const y = Float64Array.from(x1, (v) => (r() < 1 / (1 + Math.exp(-(1.5 * v - 0.5))) ? 1 : 0));
  const m = lab.fitLogistic([x1, x2], y);
  assert.ok(m.w[0] > 1.0 && m.w[0] < 1.8, `weight ${m.w[0]}`);
  assert.ok(Math.abs(m.w[1]) < 0.15, `useless input weight ${m.w[1]}`);
  assert.ok(m.bias < -0.3 && m.bias > -0.7, `bias ${m.bias}`);
  assert.ok(lab.auc(y, lab.predictLogistic(m, [x1, x2])) > 0.75);
});

test('weekly rows use only what was known: features at a week end do not move when the future changes', () => {
  const w = market({ n: 3, sessions: 700, seed: 5 });
  const a = lab.stockRows(w.stocks[0], { ...spyOf(w.spy) });
  const bars = w.stocks[0].bars;
  const changed = { ...w.stocks[0], bars: { ...bars, close: Float64Array.from(bars.close, (c, i) => (i > 500 ? c * 3 : c)), open: Float64Array.from(bars.open, (c, i) => (i > 500 ? c * 3 : c)), volume: Float64Array.from(bars.volume, (v, i) => (i > 500 ? v * 4 : v)) } };
  const b = lab.stockRows(changed, { ...spyOf(w.spy) });
  const cutoff = bars.days[498];
  const early = a.filter((r) => r.day < cutoff);
  assert.ok(early.length > 30);
  for (const r of early) {
    const q = b.find((x) => x.day === r.day);
    for (const k of ['vol20', 'vol60', 'ret5', 'ret60', 'mom12_1', 'hi52', 'lo52', 'ldvol', 'since_earn', 'wz']) assert.equal(String(q[k]), String(r[k]), `${k} on ${r.day}`);
  }
});
function spyOf(spy) {
  const n = spy.days.length;
  const ret = new Float64Array(n).fill(NaN); for (let i = 1; i < n; i++) ret[i] = spy.close[i] / spy.close[i - 1] - 1;
  const vol20 = new Float64Array(n).fill(NaN);
  for (let i = 20; i < n; i++) { let s = 0, ss = 0; for (let k = i - 19; k <= i; k++) { s += ret[k]; ss += ret[k] ** 2; } const m = s / 20; vol20[i] = Math.sqrt(Math.max(0, ss / 20 - m * m) * (20 / 19)); }
  return { close: spy.close, open: spy.open, vol20, index: new Map(Array.from(spy.days, (d, i) => [d, i])) };
}

test('membership dates keep a stock out of the sample before it joined and after it left', () => {
  const w = market({ n: 1, sessions: 800, seed: 6 });
  const days = w.stocks[0].bars.days;
  const s = { ...w.stocks[0], addedDay: days[400], removedDay: days[600] };
  const rows = lab.stockRows(s, spyOf(w.spy));
  assert.ok(rows.length > 20);
  assert.ok(rows.every((r) => r.day >= days[400] && r.day <= days[600]));
});

test('in a market with no real patterns, no portfolio makes money after costs', async () => {
  const w = market({ n: 70, seed: 7, driftSd: 0 });
  const out = await lab.runLab2({ stocks: w.stocks, spy: w.spy, horizons: [20], B: 100, sets: [{ id: 'price', label: 'p', big: lab.FEATURES.price, dir: ['mom12_1', 'ret60', 'ret120', 'hi52', 'lo52'] }] });
  assert.equal(out.status, 'ok');
  const e = out.horizons[20];
  assert.ok(e.models[0].all.lsNet < 0.004, `score portfolio ${e.models[0].all.lsNet}`);
  assert.ok(e.models[0].stage2.auc === null || Math.abs(e.models[0].stage2.auc - 0.5) < 0.1, `direction AUC ${e.models[0].stage2.auc}`);
  const rand = e.baselines.find((b) => b.id === 'random');
  assert.ok(rand.lsNet < 0 && rand.lsNet > -0.012, `random scores lose about the costs: ${rand.lsNet}`);
});

test('when drifts last for months (momentum), the lab finds it: direction is predicted and the long-short portfolio makes money', async () => {
  const w = market({ n: 70, seed: 8, driftSd: 0.0007, rho: 0.99 });
  const out = await lab.runLab2({ stocks: w.stocks, spy: w.spy, horizons: [20], B: 100, sets: [{ id: 'price', label: 'p', big: lab.FEATURES.price, dir: ['mom12_1', 'ret60', 'ret120', 'hi52', 'lo52'] }] });
  const e = out.horizons[20];
  assert.ok(e.baselines.find((b) => b.id === 'momentum').lsNet > 0.004, `momentum ${e.baselines.find((b) => b.id === 'momentum').lsNet}`);
  assert.ok(e.models[0].stage2.auc > 0.55, `direction AUC ${e.models[0].stage2.auc}`);
  assert.ok(e.models[0].directionOnly.lsNet > 0.003, `direction-only portfolio ${e.models[0].directionOnly.lsNet}`);
});

test('the lab job loads the universe from the database (members, leavers, prices, page views), runs, and stores the result', async () => {
  const { setup, resetRave, signedInAgent } = require('./helpers');
  const prices = require('../src/rave/prices');
  const wiki = require('../src/rave/wiki');
  const { runLab2Job } = require('../src/rave/lab2job');
  const { pool, app } = await setup();
  try {
    await resetRave(pool);
    await pool.query('DELETE FROM universe');
    const w = market({ n: 110, sessions: 800, seed: 11, driftSd: 0.0005 });
    const iso = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
    const rows = (b) => Array.from(b.days, (d, i) => ({ day: iso(d), open: b.open[i], close: b.close[i], volume: b.volume ? b.volume[i] : 1e8 }));
    await prices.savePrices(pool, 'SPY', rows(w.spy));
    for (const [i, s] of w.stocks.entries()) {
      const leaver = i < 5;
      await pool.query(`INSERT INTO universe (ticker, name, article, index_name, active, removed_day) VALUES ($1, $2, $3, 'sp500', $4, $5)`, [s.ticker, `Company ${i}`, i % 2 ? `Article ${i}` : null, !leaver, leaver ? iso(s.bars.days[600]) : null]);
      await prices.savePrices(pool, s.ticker, rows(s.bars));
      if (i % 2) {
        await pool.query(`INSERT INTO wiki_pages (ticker, article, status, confidence, source) VALUES ($1, $2, 'resolved', 'high', 'index')`, [s.ticker, `Article ${i}`]);
        await wiki.saveViews(pool, `Article ${i}`, s.views.values.slice(0, 400).map((v, k) => ({ day: iso(s.views.start + k), views: v })));
      }
    }
    await pool.query(`INSERT INTO universe (ticker, name, index_name, active, removed_day) VALUES ('GHOST', 'Ghost Co', 'sp600', false, '2023-01-02')`); // a leaver with no prices at all
    const out = await runLab2Job(pool, { B: 50, horizons: [20], log: { log() {}, error() {} } });
    assert.equal(out.status, 'ok');
    const { rows: [row] } = await pool.query(`SELECT results FROM validation_runs WHERE kind = 'lab2'`);
    assert.deepEqual([row.results.coverage.members, row.results.coverage.withPrices, row.results.coverage.removedTotal, row.results.coverage.removedWithPrices], [111, 110, 6, 5]);
    assert.ok(row.results.horizons[20].models.length === 3 && row.results.horizons[20].baselines.length === 3);
    const { agent } = await signedInAgent(app);
    const { body } = await agent.get('/api/rave/research').expect(200);
    assert.equal(body.lab2.status, 'ok');
  } finally {
    await pool.end();
  }
});
