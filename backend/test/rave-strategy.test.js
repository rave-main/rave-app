const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./validation-world');
const lab = require('../src/rave/strategy');

const run = (w) => lab.runStrategyLab({ series: w.series, bench: w.bench, B: 150 });
const rule = (r, id) => r.rules.find((x) => x.id === id);

test('winsorise clips the extremes and leaves small samples alone', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i);
  xs[99] = 10000;
  assert.ok(Math.max(...lab.winsorise(xs)) < 200);
  assert.deepEqual(lab.winsorise([1, 2, 3]), [1, 2, 3]);
});

test('with no real effect, no rule makes money after costs and spikes do not add big swings', () => {
  const r = run(world({ seed: 31, tickers: 40, effect: {} }));
  assert.equal(r.status, 'ok');
  assert.ok(r.counts.spikes > 300, `${r.counts.spikes} spikes`);
  const all = r.direction.find((d) => d.label === 'All spikes');
  assert.ok(all.development.ci[0] < 0.004 && all.development.ci[1] > -0.004, `development range ${all.development.ci}`);
  for (const id of ['buy', 'fade', 'fadeStrong']) {
    const x = rule(r, id);
    assert.ok(x.dev.mean < 0.001, `${id}: ${x.dev.mean}`);
    assert.ok(Math.abs(x.dev.grossMean) < 0.006, `${id} gross ${x.dev.grossMean}`);
  }
  const q = r.swings.rows;
  for (const v of new Set(q.map((x) => x.volatility))) {
    const a = q.find((x) => x.volatility === v && !x.spike);
    const b = q.find((x) => x.volatility === v && x.spike);
    if (a && b) assert.ok(Math.abs(a.bigShare - b.bigShare) < 0.04, `${v}: ${a.bigShare} vs ${b.bigShare}`);
  }
});

test('a planted fall after spikes is found by the rule that bets against them, and nothing else', () => {
  const r = run(world({ seed: 32, tickers: 40, effect: { drift: -0.012, lag: 2 } }));
  const all = r.direction.find((d) => d.label === 'All spikes');
  assert.ok(all.development.ci[1] < -0.01, `development range ${all.development.ci}`);
  const fade = rule(r, 'fade');
  assert.ok(fade.dev.mean > 0.03, `fade net ${fade.dev.mean}`);
  assert.ok(rule(r, 'buy').dev.mean < -0.03);
  assert.ok(fade.dev.quartersPositive >= fade.dev.quarters.length - 1, 'profitable in nearly every quarter');
  assert.ok(fade.dev.totalDollars > 0 && fade.curve.length > 5);
});

test('planted extra volatility raises the share of big swings, in every volatility group', () => {
  const r = run(world({ seed: 33, tickers: 40, volCluster: true, effect: { volMult: 3, lag: 2 } }));
  const q = r.swings.rows;
  let compared = 0;
  for (const v of new Set(q.map((x) => x.volatility))) {
    const a = q.find((x) => x.volatility === v && !x.spike);
    const b = q.find((x) => x.volatility === v && x.spike);
    if (a && b && a.bigShare > 0.02) { compared++; assert.ok(b.bigShare > a.bigShare, `${v}: ${a.bigShare} vs ${b.bigShare}`); }
  }
  assert.ok(compared >= 2);
});

test('with too little data the lab says so instead of inventing results', () => {
  const w = world({ seed: 34, tickers: 3, days: 300 });
  assert.equal(run(w).status, 'insufficient');
});

test('the research job stores the strategy lab and the API returns it', async () => {
  const { setup, resetRave, signedInAgent } = require('./helpers');
  const prices = require('../src/rave/prices');
  const wiki = require('../src/rave/wiki');
  const research = require('../src/rave/research');
  const { pool, app } = await setup();
  try {
    await resetRave(pool);
    const w = world({ seed: 35, tickers: 12, effect: {} });
    const rows = (rs) => rs.map((r) => ({ day: r.day, open: r.open, high: Math.max(r.open, r.close), low: Math.min(r.open, r.close), close: r.close, adjClose: r.close, volume: r.volume }));
    await prices.savePrices(pool, 'SPY', rows(w.bench), 'yahoo');
    for (let i = 0; i < w.series.length; i++) {
      const s = w.series[i];
      await pool.query(`INSERT INTO tickers (ticker, name, first_seen, last_seen, fetched_at, ranked, mentions) VALUES ($1, $2, now(), now(), now(), true, 10)`, [`W${i}`, `Company ${i}`]);
      await pool.query(`INSERT INTO wiki_pages (ticker, article, status, confidence, source) VALUES ($1, $2, 'resolved', 'high', 'auto')`, [`W${i}`, `Article ${i}`]);
      const start = Date.parse(`${s.startDay}T00:00:00Z`);
      await wiki.saveViews(pool, `Article ${i}`, s.values.map((views, k) => ({ day: new Date(start + k * 86400000).toISOString().slice(0, 10), views })));
      await prices.savePrices(pool, `W${i}`, rows(s.prices), 'yahoo');
    }
    const out = await research.runResearch(pool, { B: 60, log: { log() {}, error() {} } });
    assert.equal(out.status, 'ok');
    assert.equal(out.lab, 'ok');
    const { agent } = await signedInAgent(app);
    const { body } = await agent.get('/api/rave/research').expect(200);
    assert.equal(body.lab.status, 'ok');
    assert.ok(body.lab.rules.length === 6 && body.lab.direction.length === 10 && body.lab.caveats.length >= 3);
  } finally {
    await pool.end();
  }
});
