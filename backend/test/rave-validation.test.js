const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/rave/validation');

const DAY = 86400000;
const START = '2023-01-02'; // a Monday
const day = (i) => new Date(Date.parse(`${START}T00:00:00Z`) + i * DAY).toISOString().slice(0, 10);
const isWeekday = (i) => { const d = new Date(Date.parse(`${START}T00:00:00Z`) + i * DAY).getUTCDay(); return d !== 0 && d !== 6; };

function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()); }

// A synthetic market. Attention spikes at random days; `effect` decides what (if anything) prices do about it.
//   volMult / drift: applied on the 5 trading days starting `effectLag` calendar days after the spike day
//   sameDayVol: the stock also moves a lot ON the spike day itself (news moves both; not tradable)
//   attentionFollowsPrice: attention spikes the day AFTER a big price move instead of leading it
function world({ tickers = 30, days = 1100, seed = 1, effect = {}, attentionFollowsPrice = false }) {
  const r = v.makeRng(seed);
  const trading = Array.from({ length: days }, (_, i) => i).filter(isWeekday);
  const mkt = trading.map(() => 0.0003 + 0.009 * gauss(r));
  const mktByDay = new Map(trading.map((d, k) => [d, mkt[k]]));
  const benchClose = [];
  let b = 100;
  const bench = trading.map((d, k) => { const open = b * (1 + 0.3 * mkt[k]); b *= 1 + mkt[k]; benchClose.push(b); return { day: day(d), open, close: b, volume: 1e8 }; });

  const series = [];
  for (let t = 0; t < tickers; t++) {
    const spikeAt = new Set();
    const attn = Array.from({ length: days }, (_, i) => Math.round(1500 * (i % 7 >= 5 ? 0.7 : 1) * Math.exp(0.12 * gauss(r))));
    for (let i = 40; i < days - 30; i++) {
      if (!attentionFollowsPrice && r() < 1 / 55) {
        spikeAt.add(i);
        const len = 1 + Math.floor(r() * 3);
        const mult = 3 + 3 * r();
        for (let k = 0; k < len; k++) attn[i + k] = Math.round(attn[i + k] * mult);
      }
    }
    // idiosyncratic returns, with the effect injected
    const idio = trading.map(() => 0.015 * gauss(r));
    const volume = trading.map(() => 1e6 * Math.exp(0.15 * gauss(r)));
    const tIndex = new Map(trading.map((d, k) => [d, k]));
    // first trading day on/after calendar day `cal`; past the end of the data there is none (no effect is injected)
    const firstTradingFrom = (cal) => { let c = cal; while (c < days && !tIndex.has(c)) c++; return c < days ? tIndex.get(c) : trading.length; };
    for (const s of spikeAt) {
      if (effect.sameDayVol && tIndex.has(s)) idio[tIndex.get(s)] *= effect.sameDayVol;
      const e0 = firstTradingFrom(s + (effect.lag ?? 2));
      for (let k = 0; k < 5 && e0 + k < trading.length; k++) {
        if (effect.volMult) { idio[e0 + k] *= effect.volMult; volume[e0 + k] *= 1 + (effect.volMult - 1) * 0.5; }
        if (effect.drift) idio[e0 + k] += effect.drift;
      }
    }
    if (attentionFollowsPrice) {
      for (let k = 1; k < trading.length - 3; k++) {
        if (Math.abs(idio[k]) > 2.2 * 0.015 && r() < 0.9) {
          const a = trading[k] + 1;
          for (let q = 0; q < 2 && a + q < days; q++) attn[a + q] = Math.round(attn[a + q] * 4);
        }
      }
    }
    let close = 50;
    const prices = trading.map((d, k) => {
      const ret = 1.1 * mkt[k] + idio[k];
      const open = close * (1 + 0.3 * ret);
      close *= 1 + ret;
      return { day: day(d), open, close, volume: volume[k] * (1 + 4 * Math.abs(idio[k])) };
    });
    series.push({ ticker: `S${t}`, startDay: START, values: attn, prices, spikes: [...spikeAt] });
  }
  return { series, bench };
}

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
  assert.ok(r.volume.mean > 0.05 && r.volume.p < 0.05, 'volume rises too');
  assert.ok(r.direction.p > 0.01, `direction p ${r.direction.p}`);
  const vd = v.verdict(s);
  assert.equal(vd.level, 'size');
  assert.match(vd.headline, /larger price moves, but not in a consistent direction/);
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
