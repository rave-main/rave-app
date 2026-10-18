const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/rave/validation');

const { world, START, day } = require('./validation-world');

const study = async (w, opts = {}) => v.eventStudy({ series: w.series, bench: w.bench, B: 600, seed: 9, ...opts });

test('outcomeAt: enters at the open, exits at the close of the h-th day, and subtracts the benchmark over the same window', () => {
  const rows = [
    { day: '2024-01-02', open: 10, close: 11, volume: 100 },
    { day: '2024-01-03', open: 11, close: 12, volume: 100 },
    { day: '2024-01-04', open: 12, close: 15, volume: 100 },
  ];
  const bench = v.indexPrices([
    { day: '2024-01-02', open: 100, close: 100, volume: 1 },
    { day: '2024-01-03', open: 100, close: 101, volume: 1 },
    { day: '2024-01-04', open: 101, close: 105, volume: 1 },
  ]);
  const px = v.indexPrices(rows);
  const one = v.outcomeAt(px, bench, 1, 1);
  assert.ok(Math.abs(one.ret - (12 / 11 - 1)) < 1e-12);
  assert.ok(Math.abs(one.abn - ((12 / 11 - 1) - (101 / 100 - 1))) < 1e-12);
  const two = v.outcomeAt(px, bench, 1, 2); // 2 days: enter day 2 open (11), exit day 3 close (15)
  assert.ok(Math.abs(two.ret - (15 / 11 - 1)) < 1e-12);
  assert.ok(Math.abs(two.abn - ((15 / 11 - 1) - (105 / 100 - 1))) < 1e-12);
  assert.equal(v.outcomeAt(px, bench, 2, 2), null, 'the window runs past the data');
  assert.equal(two.vol, null, 'not enough history for the volume baseline');
});

test('entry is the first trading day on or after signal day + lag, never earlier', () => {
  const px = v.indexPrices(['2024-01-05', '2024-01-08', '2024-01-09'].map((d) => ({ day: d, open: 1, close: 1, volume: 1 })));
  assert.equal(px.days[v.firstTradingOnOrAfter(px, '2024-01-06')], '2024-01-08', 'a Saturday rolls to Monday');
  assert.equal(px.days[v.firstTradingOnOrAfter(px, '2024-01-05')], '2024-01-05');
  assert.equal(v.firstTradingOnOrAfter(px, '2024-02-01'), -1);
});

test('findEvents keeps the first day of an episode and respects the cool-down', () => {
  const vals = Array.from({ length: 120 }, (_, i) => 1000 + (i % 7));
  for (const i of [60, 61, 62]) vals[i] = 6000; // one 3-day episode
  vals[100] = 7000; // a separate one
  const ev = v.findEvents(vals, START, { cooldownDays: 10 });
  assert.deepEqual(ev.map((e) => e.index), [60, 100]);
  assert.ok(ev.every((e) => ['Hot', 'Extreme'].includes(e.label)));
  assert.equal(ev[0].day, day(60));
});

test('NO effect in the data: no evidence is found (false-positive rate stays low)', async () => {
  let falsePositives = 0;
  const runs = 12;
  for (let seed = 1; seed <= runs; seed++) {
    const s = await study(world({ seed: 100 + seed }), { horizons: [5] });
    assert.ok(s.events > 200, `${s.events} events`);
    const r = s.results[5];
    if (r.size.p < 0.025 || r.direction.p < 0.025) falsePositives++;
    assert.ok(r.direction.ci[0] < 0.02 && r.direction.ci[1] > -0.02);
  }
  assert.ok(falsePositives <= 2, `${falsePositives} of ${runs} worlds showed a false positive at p<0.025 (expected about ${runs * 0.05})`);
});

test('a volatility effect (moves 2.5x larger for 5 days after a spike) is detected, with no invented direction', async () => {
  const s = await study(world({ seed: 5, effect: { volMult: 2.5, lag: 2 } }), { horizons: [1, 5, 20] });
  const r = s.results[5];
  assert.ok(r.size.mean > 0.004, `size excess ${r.size.mean}`);
  assert.ok(r.size.p < 0.005, `p ${r.size.p}`);
  assert.ok(r.size.ci[0] > 0);
  const m = s.matched[5].size;
  assert.ok(m.p < 0.01 && m.mean > 0.8 * r.size.mean, `a real effect survives matching on recent volatility (${m.mean} vs ${r.size.mean})`);
  assert.ok(r.volume.mean > 0.05 && r.volume.p < 0.05, 'volume rises too');
  assert.ok(r.direction.p > 0.01, `direction p ${r.direction.p}`);
  const vd = v.verdict(s);
  assert.equal(vd.level, 'size');
  assert.match(vd.headline, /larger price moves.*but not in a consistent direction/);
});

test('volatility clustering with attention that FOLLOWS price: the plain test is fooled, the volatility-matched test is not', async () => {
  for (const seed of [32, 34, 36]) {
    const s = await study(world({ seed, volCluster: true, attentionFollowsPrice: true }), { horizons: [5], B: 300 });
    const plain = s.results[5].size;
    const matched = s.matched[5].size;
    assert.ok(plain.p < 0.01 && plain.mean > 0.01, `without matching it looks like an effect (${(plain.mean * 100).toFixed(2)}%, p ${plain.p})`);
    assert.ok(matched.mean < 0.4 * plain.mean, `matching removes most of it: ${(matched.mean * 100).toFixed(2)}% vs ${(plain.mean * 100).toFixed(2)}%`);
    const vd = v.verdict(s);
    assert.equal(vd.level, 'marker', `seed ${seed}: ${vd.headline}`);
    assert.match(vd.headline, /already moving a lot/);
    assert.match(vd.details.join(' '), /% of the plain difference remains/);
  }
});

test('a drift effect (+0.8% a day for 5 days) is detected as direction', async () => {
  const s = await study(world({ seed: 6, effect: { drift: 0.008, lag: 2 } }), { horizons: [5] });
  const r = s.results[5];
  assert.ok(r.direction.mean > 0.025 && r.direction.mean < 0.05, `excess ${r.direction.mean}`);
  assert.ok(r.direction.p < 0.005);
  assert.ok(r.direction.hitRate > r.direction.controlHitRate + 0.1);
  assert.match(v.verdict(s).level, /^(direction|both)$/);
});

test('an effect that happens only ON the spike day is NOT counted at a realistic entry, but is if look-ahead is allowed', async () => {
  const w = world({ seed: 7, effect: { sameDayVol: 4, lag: 99 } }); // lag 99: nothing after; only the spike day moves
  const realistic = await study(w, { horizons: [5], lagDays: 2 });
  assert.ok(realistic.results[5].size.p > 0.02, `entering 2 days later sees nothing (p ${realistic.results[5].size.p})`);
  assert.equal(v.verdict(realistic).level, 'none');
  const cheating = await study(w, { horizons: [1], lagDays: 0 });
  assert.ok(cheating.results[1].size.p < 0.005, `with look-ahead the same-day move shows (p ${cheating.results[1].size.p})`);
});

test('lead-lag: when price moves follow attention the correlation is larger at positive lags; when attention follows price, at negative lags', async () => {
  const led = await v.leadLag({ ...world({ seed: 8, effect: { volMult: 3, lag: 1 }, tickers: 20 }), maxLag: 5, B: 100 });
  const lag = (rows, k) => rows.find((r) => r.lag === k).size.r;
  const ahead = lag(led, 1) + lag(led, 2) + lag(led, 3);
  const behind = lag(led, -1) + lag(led, -2) + lag(led, -3);
  assert.ok(ahead > behind + 0.05, `attention leads: ${ahead.toFixed(3)} vs ${behind.toFixed(3)}`);

  const followed = await v.leadLag({ ...world({ seed: 9, attentionFollowsPrice: true, tickers: 20 }), maxLag: 5, B: 100 });
  const ahead2 = lag(followed, 1) + lag(followed, 2) + lag(followed, 3);
  const behind2 = lag(followed, -1) + lag(followed, -2) + lag(followed, -3);
  assert.ok(behind2 > ahead2 + 0.05, `attention follows: ${behind2.toFixed(3)} vs ${ahead2.toFixed(3)}`);
  assert.equal(led.length, 11);
  assert.ok(led[0].size.ci[0] <= led[0].size.r && led[0].size.r <= led[0].size.ci[1]);
});

test('verdict handles too few events and reports numbers in plain language', () => {
  const none = v.verdict({ lagDays: 2, results: { 5: { size: { n: 7 } } } });
  assert.equal(none.level, 'insufficient');
  assert.match(none.headline, /7 so far, 30 needed/);
  const cell = (mean, p, eventMean, controlMean) => ({ n: 120, mean, p, ci: [mean - 0.01, mean + 0.01], eventMean, controlMean, hitRate: 0.5, controlHitRate: 0.5 });
  const flat = v.verdict({ lagDays: 2, results: { 5: { size: cell(0.001, 0.4, 0.02, 0.019), direction: cell(0.0005, 0.6, 0.001, 0.0005) } } });
  assert.equal(flat.level, 'none');
  assert.match(flat.headline, /No evidence/);
  assert.match(flat.details[0], /2\.00% after a spike vs 1\.90% on ordinary days/);
  const both = v.verdict({ lagDays: 2, results: { 5: { size: cell(0.01, 0.001, 0.03, 0.02), direction: cell(0.01, 0.002, 0.01, 0) } } });
  assert.equal(both.level, 'both');
});
