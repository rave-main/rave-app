// Strategy lab: why do share prices swing after a jump in attention, can the swings be split into up and down, and would a
// simple trading rule have made money? Everything here is a fixed, written-down procedure (see METHODOLOGY.md); nothing is
// tuned on the results. Signals come from Wikipedia page views (the only attention source with years of history).
//
// Timing: a spike on calendar day d is visible after that day ends, so the earliest realistic purchase is the open of the first
// trading day on or after d + lagDays (2). Prices known at the time of the decision are those up to the last trading day <= d.
// Outcomes are market-adjusted: the share's gain from that open to the close `hold` trading days later, minus SPY over the
// same dates.
const { median } = require('./stats');
const { makeRng } = require('./validation');

const DAY = 86400000;
const HOLD = 5;
const BIG_MOVE = 0.10; // a "big swing" is a move of more than 10% (up or down, versus the market) over the 5 trading days
const MIN_VIEWS = 100; // typical page views a day below which attention is too noisy to rate
const SPIKE_Z = 4;
const STRONG_Z = 5;
const COOLDOWN_DAYS = 10;
const HOLDOUT_DAYS = 183; // the most recent six months are reported separately
const COSTS = { roundTrip: 0.003, hedge: 0.0002, borrowPerYear: 0.05 }; // 0.3% to trade the share, 0.02% for the SPY hedge, 5% a year to borrow a share for a short

const ms = (day) => Date.parse(`${day}T00:00:00Z`);
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

function winsorise(xs, p = 0.02) {
  if (xs.length < 20) return xs;
  const s = [...xs].sort((a, b) => a - b);
  const lo = s[Math.floor(p * (s.length - 1))];
  const hi = s[Math.ceil((1 - p) * (s.length - 1))];
  return xs.map((x) => Math.min(hi, Math.max(lo, x)));
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Rolling window helpers on the trading-day price rows
function prepare(stock, bench) {
  const px = stock.prices;
  const n = px.length;
  const t = px.map((p) => ms(p.day));
  const ret = px.map((p, i) => (i ? p.close / px[i - 1].close - 1 : null));
  const vol20 = px.map((_, i) => {
    if (i < 20) return null;
    const w = ret.slice(i - 19, i + 1);
    const m = mean(w);
    return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / 19);
  });
  const hi52 = px.map((p, i) => (i < 100 ? null : p.close / Math.max(...px.slice(Math.max(0, i - 249), i + 1).map((q) => q.close)) - 1));
  const dvol = px.map((_, i) => (i < 19 ? null : median(px.slice(i - 19, i + 1).map((q) => q.close * q.volume))));
  return { px, n, t, ret, vol20, hi52, dvol, tIndex: new Map(t.map((x, i) => [x, i])) };
}

// Robust attention score for calendar day d, from the 28 days before it (log scale, median and scaled MAD)
function attentionAt(values, k) {
  if (k < 28 || values[k] == null) return null;
  const w = [];
  for (let j = k - 28; j < k; j++) if (values[j] != null) w.push(Math.log1p(values[j]));
  if (w.length < 20) return null;
  const med = median(w);
  const mad = 1.4826 * median(w.map((x) => Math.abs(x - med)));
  return { z: (Math.log1p(values[k]) - med) / Math.max(mad, 0.05), level: Math.expm1(med) };
}

// Every calendar day with an attention reading: the features known at the time and the outcome of buying at the realistic entry
function observations(stock, benchIdx, { lagDays = 2, hold = HOLD } = {}) {
  const P = prepare(stock, null);
  if (P.n < 130) return [];
  const t0 = ms(stock.startDay);
  const out = [];
  let i = 0; // last trading row on or before the calendar day
  const firstT = P.t[0];
  const lastT = P.t[P.n - 1];
  for (let k = 28; k < stock.values.length; k++) {
    const dayMs = t0 + k * DAY;
    if (dayMs < firstT + 100 * DAY || dayMs > lastT) continue;
    while (i + 1 < P.n && P.t[i + 1] <= dayMs) i++;
    const a = attentionAt(stock.values, k);
    if (!a || a.level < MIN_VIEWS || P.vol20[i] == null || P.hi52[i] == null) continue;
    // entry: first trading row on or after dayMs + lagDays
    let e = i + 1;
    while (e < P.n && P.t[e] < dayMs + lagDays * DAY) e++;
    const x = e + hold - 1;
    if (x >= P.n) continue;
    const bo = benchIdx.get(P.px[e].day);
    const bc = benchIdx.get(P.px[x].day);
    if (!bo || !bc) continue;
    const stockRet = P.px[x].close / P.px[e].open - 1;
    const abn = stockRet - (bc.close / bo.open - 1);
    out.push({
      ticker: stock.ticker, day: isoDay(dayMs), entry: P.px[e].day, exit: P.px[x].day, z: a.z,
      vol20: P.vol20[i], rSig: P.ret[i], r5: i >= 5 ? P.px[i].close / P.px[i - 5].close - 1 : null, hi52: P.hi52[i], dvol: P.dvol[i], price: P.px[i].close,
      abn, abs: Math.abs(abn),
    });
  }
  return out;
}

// Price-only reference events (no attention at all): a one-day jump of 10% or more, bought or bet against at the next open
function jumpEvents(stock, benchIdx, { hold = HOLD, minJump = 0.10 } = {}) {
  const P = prepare(stock, null);
  const out = [];
  let lastT = -Infinity;
  for (let i = 100; i < P.n - hold - 1; i++) {
    if (P.ret[i] < minJump || P.t[i] - lastT < COOLDOWN_DAYS * DAY) continue;
    const e = i + 1;
    const x = e + hold - 1;
    const bo = benchIdx.get(P.px[e].day);
    const bc = benchIdx.get(P.px[x].day);
    if (!bo || !bc) continue;
    lastT = P.t[i];
    const abn = P.px[x].close / P.px[e].open - 1 - (bc.close / bo.open - 1);
    out.push({ ticker: stock.ticker, day: P.px[i].day, entry: P.px[e].day, exit: P.px[x].day, abn, abs: Math.abs(abn), z: null, rSig: P.ret[i], r5: null, hi52: P.hi52[i], dvol: P.dvol[i] });
  }
  return out;
}

// First day of each attention episode: z at or above the threshold, no earlier event for that share in the previous 10 days
function pickEvents(obs, zMin) {
  const last = new Map();
  const out = [];
  for (const o of obs) {
    if (o.z < zMin) continue;
    const prev = last.get(o.ticker);
    const t = ms(o.day);
    if (prev !== undefined && t - prev < COOLDOWN_DAYS * DAY) continue;
    last.set(o.ticker, t);
    out.push(o);
  }
  return out;
}

// Average of the winsorised outcomes, with a 95% range from resampling whole shares (events of one share are not independent)
function summarise(events, pick, rng, B = 300) {
  const xs = events.map(pick).filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  if (xs.length < 5) return { n: xs.length };
  const w = winsorise(xs);
  const byTicker = new Map();
  events.forEach((e) => {
    const v = pick(e);
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    if (!byTicker.has(e.ticker)) byTicker.set(e.ticker, []);
    byTicker.get(e.ticker).push(v);
  });
  const groups = [...byTicker.values()];
  const lo = [...xs].sort((a, b) => a - b);
  const cut = [lo[Math.floor(0.02 * (lo.length - 1))], lo[Math.ceil(0.98 * (lo.length - 1))]];
  const clip = (v) => Math.min(cut[1], Math.max(cut[0], v));
  const boots = [];
  for (let b = 0; b < B; b++) {
    let s = 0, c = 0;
    for (let q = 0; q < groups.length; q++) {
      const g = groups[Math.floor(rng() * groups.length)];
      for (const v of g) { s += clip(v); c++; }
    }
    boots.push(s / c);
  }
  boots.sort((a, b) => a - b);
  return {
    n: xs.length, mean: mean(w), median: median(xs), hitRate: xs.filter((x) => x > 0).length / xs.length,
    ci: [boots[Math.floor(0.025 * (B - 1))], boots[Math.ceil(0.975 * (B - 1))]],
  };
}

const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

// ---------- what drives big swings ----------
function swingTable(obs) {
  const vols = obs.map((o) => o.vol20);
  const cuts = [0.25, 0.5, 0.75].map((q) => quantile(vols, q));
  const bucket = (v) => (v <= cuts[0] ? 0 : v <= cuts[1] ? 1 : v <= cuts[2] ? 2 : 3);
  const names = ['calmest quarter', 'second quarter', 'third quarter', 'jumpiest quarter'];
  const rows = [];
  for (let q = 0; q < 4; q++) {
    for (const spike of [false, true]) {
      const g = obs.filter((o) => bucket(o.vol20) === q && (o.z >= SPIKE_Z) === spike);
      if (g.length < 10) continue;
      rows.push({ volatility: names[q], spike, n: g.length, bigShare: g.filter((o) => o.abs > BIG_MOVE).length / g.length, typicalMove: median(g.map((o) => o.abs)) });
    }
  }
  return { cuts, rows, bigMove: BIG_MOVE };
}

// ---------- up or down? ----------
const SPLITS = [
  ['All spikes', () => true],
  ['Very strong spikes', (e) => e.z >= STRONG_Z],
  ['Price had been falling (down 3% or more over the previous 5 days)', (e) => e.r5 !== null && e.r5 <= -0.03],
  ['Price had been rising (up 3% or more over the previous 5 days)', (e) => e.r5 !== null && e.r5 >= 0.03],
  ['Price jumped on the spike day (up 2% or more)', (e) => e.rSig !== null && e.rSig >= 0.02],
  ['Price fell on the spike day (down 2% or more)', (e) => e.rSig !== null && e.rSig <= -0.02],
  ['Close to its 1-year high (within 5%)', (e) => e.hi52 >= -0.05],
  ['Far below its 1-year high (more than 30% below)', (e) => e.hi52 <= -0.30],
  ['Smaller company shares (under $50 million traded a day)', (e) => e.dvol < 5e7],
  ['Larger company shares ($1 billion or more traded a day)', (e) => e.dvol >= 1e9],
];

function directionTable(events, periods, rng) {
  return SPLITS.map(([label, test]) => {
    const row = { label };
    for (const [name, evs] of Object.entries(periods)) row[name] = summarise(evs.filter(test), (e) => e.abn, rng);
    return row;
  });
}

// ---------- trading rules ----------
const RULES = [
  { id: 'buy', label: 'Buy every spike, hold 5 trading days', side: 1, test: (e) => e.z >= SPIKE_Z },
  { id: 'fade', label: 'Bet against every spike (short the share), hold 5 trading days', side: -1, test: (e) => e.z >= SPIKE_Z },
  { id: 'fadeStrong', label: 'Bet against only the very strong spikes', side: -1, test: (e) => e.z >= STRONG_Z },
  { id: 'buyDip', label: 'Buy spikes that follow a price fall', side: 1, test: (e) => e.z >= SPIKE_Z && e.r5 !== null && e.r5 <= -0.03 },
];
// Reference rules that use no attention at all, so the attention rules can be judged against them
const JUMP_RULES = [
  { id: 'buyJump', label: 'No attention data: buy after a one-day jump of 10% or more', side: 1, test: () => true },
  { id: 'fadeJump', label: 'No attention data: bet against a one-day jump of 10% or more', side: -1, test: () => true },
];

// Net result of one trade per spike with $1,000 in the share and $1,000 of SPY on the other side (market-neutral)
function tradeNet(e, side, costs) {
  const gross = side * e.abn;
  const fee = costs.roundTrip + costs.hedge + (side < 0 ? (costs.borrowPerYear * HOLD) / 252 : 0);
  return gross - fee;
}

function ruleResult(rule, events, holdStart, costs, rng) {
  const mine = events.filter(rule.test);
  const dev = mine.filter((e) => e.entry < holdStart);
  const hold = mine.filter((e) => e.entry >= holdStart);
  const net = (e) => tradeNet(e, rule.side, costs);
  const period = (evs) => {
    const s = summarise(evs, net, rng);
    const dollars = evs.map((e) => 1000 * net(e));
    let peak = 0, cum = 0, dd = 0;
    [...evs].sort((a, b) => (a.exit < b.exit ? -1 : 1)).forEach((e) => { cum += 1000 * net(e); peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); });
    const sensitivity = [0, 0.002, 0.004].map((c) => mean(evs.map((e) => rule.side * e.abn - c - (rule.side < 0 ? (costs.borrowPerYear * HOLD) / 252 : 0))));
    const byQuarter = new Map();
    evs.forEach((e) => { const q = `${e.entry.slice(0, 4)} Q${Math.floor((Number(e.entry.slice(5, 7)) - 1) / 3) + 1}`; if (!byQuarter.has(q)) byQuarter.set(q, []); byQuarter.get(q).push(net(e)); });
    const quarters = [...byQuarter.entries()].filter(([, v]) => v.length >= 10).sort().map(([q, v]) => ({ quarter: q, n: v.length, mean: mean(v) }));
    return { ...s, quarters, quartersPositive: quarters.filter((q) => q.mean > 0).length, perTradeDollars: s.n ? 1000 * s.mean : null, totalDollars: dollars.reduce((a, b) => a + b, 0), worstTrade: dollars.length ? Math.min(...dollars) : null, maxDrawdown: dd, grossMean: mean(evs.map((e) => rule.side * e.abn)), sensitivity };
  };
  // equity curve: cumulative dollars by exit week, development then holdout
  const sorted = [...mine].sort((a, b) => (a.exit < b.exit ? -1 : 1));
  const curve = [];
  let cum = 0;
  sorted.forEach((e, i) => {
    cum += 1000 * net(e);
    if (i === sorted.length - 1 || sorted[i + 1].exit.slice(0, 8) !== e.exit.slice(0, 8)) curve.push({ day: e.exit, dollars: Math.round(cum), holdout: e.entry >= holdStart });
  });
  return { id: rule.id, label: rule.label, side: rule.side > 0 ? 'long' : 'short', dev: period(dev), holdout: period(hold), curve: curve.filter((_, i) => i % 2 === 0) };
}

// series: [{ ticker, startDay, values (daily page views), prices: [{ day, open, close, volume }] }]; bench: SPY rows
function runStrategyLab({ series, bench, B = 300, seed = 21, costs = COSTS }) {
  const benchIdx = new Map(bench.map((b) => [b.day, b]));
  const all = [];
  for (const s of series) all.push(...observations(s, benchIdx));
  if (all.length < 500) return { status: 'insufficient', reason: `only ${all.length} usable days of attention and prices` };
  const lastEntry = all.reduce((m, o) => (o.entry > m ? o.entry : m), '');
  const holdStart = isoDay(ms(lastEntry) - HOLDOUT_DAYS * DAY);
  const devCut = isoDay(ms(holdStart) - 30 * DAY); // events whose 5-day window would reach into the holdout are left out of development
  const rng = makeRng(seed);
  const spikes = pickEvents(all, SPIKE_Z);
  const jumps = series.flatMap((s) => jumpEvents(s, benchIdx));
  const periods = { development: spikes.filter((e) => e.entry < devCut), holdout: spikes.filter((e) => e.entry >= holdStart) };
  return {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    setup: { hold: HOLD, spikeZ: SPIKE_Z, strongZ: STRONG_Z, bigMove: BIG_MOVE, minViews: MIN_VIEWS, lagDays: 2, costs, holdoutStart: holdStart, firstDay: all[0].day, lastDay: all[all.length - 1].day },
    counts: { days: all.length, spikes: spikes.length, development: periods.development.length, holdout: periods.holdout.length, tickers: new Set(all.map((o) => o.ticker)).size },
    swings: swingTable(all.filter((o) => o.entry < devCut)),
    swingsHoldout: swingTable(all.filter((o) => o.entry >= holdStart)),
    baseline: {
      development: summarise(all.filter((o) => o.entry < devCut), (o) => o.abn, rng),
      holdout: summarise(all.filter((o) => o.entry >= holdStart), (o) => o.abn, rng),
    },
    direction: directionTable(spikes, periods, rng),
    rules: [...RULES.map((r) => ruleResult(r, spikes, holdStart, costs, rng)), ...JUMP_RULES.map((r) => ruleResult(r, jumps, holdStart, costs, rng))],
    variantsTried: SPLITS.length + RULES.length + JUMP_RULES.length,
  };
}

module.exports = { runStrategyLab, observations, jumpEvents, pickEvents, summarise, winsorise, swingTable, ruleResult, RULES, SPLITS, COSTS, HOLD, SPIKE_Z };
