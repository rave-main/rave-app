// Strategy lab, version 2: look over years instead of days, detect BIG SHIFTS (up or down) and then try to tell the direction.
//
// Every week, for every stock that was in the research universe at the time, we compute what was known on that day (volatility, momentum,
// distance from the 1-year high and low, a results-day estimate, Wikipedia attention, news tone when there is some) and what happened next:
// the stock's market-adjusted return over the next 20 or 60 trading days. Two models are trained only on the past (walk-forward, retrained every
// quarter, with a gap so no training label reaches into the test period):
//   stage 1: will there be a big shift, up or down? (bigger than twice what the stock's own volatility makes normal)
//   stage 2: if there is, will it be up? (trained on past big shifts only)
// Their product is a score: chance of a big shift times (2 x chance it is up - 1). The best and worst fifth of stocks are bought and sold short
// (or only bought), held for the horizon, with costs. Everything is compared with simple benchmarks (momentum, a random score) and with the
// same machinery using fewer inputs, so it is clear what attention, results dates or news add.
const { median } = require('./stats');

const DAY = 86400000;
const FEATURES = {
  price: ['vol20', 'vol60', 'vol120', 'vr', 'ret5', 'ret20', 'ret60', 'ret120', 'mom12_1', 'hi52', 'lo52', 'volsurge5', 'ldvol', 'lprice', 'spy20', 'spyvol20'],
  earn: ['since_earn', 'earn_react', 'due_in'],
  wiki: ['wz', 'wl7', 'wtrend', 'wlevel'],
  news: ['ntone', 'ntonechg', 'nvol', 'nvolchg'],
};
const DIRECTION = ['mom12_1', 'ret60', 'ret120', 'hi52', 'lo52', 'ret5', 'ret20', 'earn_react', 'wz', 'wl7', 'wtrend', 'ntone', 'ntonechg', 'spy20'];
const COST = 0.0032; // 0.3% to trade a share and 0.02% for the market hedge, per leg per round trip
const BORROW = 0.05; // a year, to borrow shares for the short leg
const SIZE = { 20: 0.1, 60: 0.2 }; // second definition of a big move: the market-adjusted price changes by at least this much (a fraction), whatever the stock's usual size
const BIG = 2; // a shift counts as big when it is at least this many times the stock's own typical move over the horizon

// ---------- small numerical tools ----------
function sorted(a) { return Float64Array.from(a).sort(); }
const quantileSorted = (s, q) => s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];

// rank-based area under the ROC curve (ties get the average rank)
function auc(y, s) {
  const n = y.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => s[a] - s[b]);
  let rankSum = 0, pos = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && s[idx[j + 1]] === s[idx[i]]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (y[idx[k]] === 1) { rankSum += r; pos++; }
    i = j + 1;
  }
  const neg = n - pos;
  return pos === 0 || neg === 0 ? null : (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

// Solves A x = b for a small dense symmetric positive matrix (Gaussian elimination with partial pivoting)
function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-12);
  }
  return x;
}

// Ridge-penalised logistic regression by Newton steps. X: array of columns (Float64Array), y: 0/1. Returns { w, bias }.
function fitLogistic(cols, y, { C = 0.3, steps = 8 } = {}) {
  const n = y.length, p = cols.length;
  const lambda = 1 / C;
  let w = Array(p + 1).fill(0);
  const prob = new Float64Array(n);
  for (let it = 0; it < steps; it++) {
    for (let i = 0; i < n; i++) {
      let z = w[0];
      for (let j = 0; j < p; j++) z += w[j + 1] * cols[j][i];
      prob[i] = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
    }
    const g = Array(p + 1).fill(0);
    const H = Array.from({ length: p + 1 }, () => Array(p + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const r = prob[i] - y[i];
      const wt = Math.max(prob[i] * (1 - prob[i]), 1e-6);
      g[0] += r;
      H[0][0] += wt;
      for (let j = 0; j < p; j++) {
        const xj = cols[j][i];
        g[j + 1] += r * xj;
        H[0][j + 1] += wt * xj;
        for (let k = j; k < p; k++) H[j + 1][k + 1] += wt * xj * cols[k][i];
      }
    }
    for (let j = 0; j <= p; j++) for (let k = 0; k < j; k++) H[j][k] = H[k][j];
    for (let j = 1; j <= p; j++) { g[j] += lambda * w[j]; H[j][j] += lambda; }
    const step = solve(H, g);
    let move = 0;
    for (let j = 0; j <= p; j++) { w[j] -= step[j]; move = Math.max(move, Math.abs(step[j])); }
    if (move < 1e-5) break;
  }
  return { w: w.slice(1), bias: w[0] };
}
const predictLogistic = (model, cols) => {
  const n = cols[0].length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let z = model.bias;
    for (let j = 0; j < cols.length; j++) z += model.w[j] * cols[j][i];
    out[i] = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  }
  return out;
};

// Winsorise at the 1st and 99th percentile of the training rows, scale to mean 0 and spread 1, missing values become 0
function makeScaler(trainCols) {
  return trainCols.map((c) => {
    const vals = Float64Array.from(c).filter((x) => Number.isFinite(x));
    if (vals.length < 20) return { lo: 0, hi: 0, mean: 0, sd: 1 };
    const s = sorted(vals);
    const lo = quantileSorted(s, 0.01), hi = quantileSorted(s, 0.99);
    let m = 0;
    for (const x of vals) m += Math.min(hi, Math.max(lo, x));
    m /= vals.length;
    let v = 0;
    for (const x of vals) v += (Math.min(hi, Math.max(lo, x)) - m) ** 2;
    return { lo, hi, mean: m, sd: Math.sqrt(v / vals.length) || 1 };
  });
}
const applyScaler = (scalers, cols, rows) => cols.map((c, j) => {
  const { lo, hi, mean, sd } = scalers[j];
  const out = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) { const x = c[rows[i]]; out[i] = Number.isFinite(x) ? (Math.min(hi, Math.max(lo, x)) - mean) / sd : 0; }
  return out;
});

// ---------- features ----------
const weekOf = (dayNum) => Math.floor((dayNum + 3) / 7); // weeks start on Monday (1970-01-01 was a Thursday)

function rollingMedianPrev(a, i, len) {
  const w = [];
  for (let k = Math.max(0, i - len); k < i; k++) w.push(a[k]);
  return w.length >= 30 ? median(w) : NaN;
}

// Estimated results days from volume surges (a day with at least 2.5x the usual volume that is also the biggest of the last 25 sessions), known without hindsight
function earningsFlags(v) {
  const n = v.length;
  const sur = new Float64Array(n).fill(NaN);
  for (let i = 60; i < n; i++) { const m = rollingMedianPrev(v, i, 60); if (m > 0) sur[i] = v[i] / m; }
  const flags = [];
  let last = -999;
  for (let i = 60; i < n; i++) {
    if (!(sur[i] >= 2.5)) continue;
    let top = true;
    for (let k = Math.max(0, i - 24); k < i; k++) if (sur[k] > sur[i]) { top = false; break; }
    if (top && i - last >= 25) { flags.push(i); last = i; }
  }
  return flags;
}

// One weekly row per stock per week (its last trading day), only while the stock was a member of the universe
function stockRows(stock, spy, { horizons = [20, 60], from = 250, last = false } = {}) {
  const { days, open, close, volume } = stock.bars;
  const n = days.length;
  if (n < from + 100) return [];
  const ret = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) ret[i] = close[i] / close[i - 1] - 1;
  const std = (i, len) => { let s = 0, ss = 0; for (let k = i - len + 1; k <= i; k++) { s += ret[k]; ss += ret[k] * ret[k]; } const m = s / len; return Math.sqrt(Math.max(0, ss / len - m * m) * (len / (len - 1))); };
  const earn = earningsFlags(volume);
  const earnIdx = new Int32Array(n).fill(-1);
  { let j = 0, prev = -1; for (let i = 0; i < n; i++) { while (j < earn.length && earn[j] <= i) { prev = earn[j]; j++; } earnIdx[i] = prev; } }
  const spyIndex = spy.index;
  const rows = [];
  // `last`: only today's row (no outcome yet), for scoring the stock as it is now
  for (let i = last ? n - 1 : from; i < (last ? n : n - 1); i++) {
    const week = weekOf(days[i]);
    if (!last && i + 1 < n && weekOf(days[i + 1]) === week) continue; // only the last trading day of the week
    const day = days[i];
    if (!last && stock.addedDay != null && day < stock.addedDay) continue;
    if (!last && stock.removedDay != null && day > stock.removedDay) continue;
    const f = { ticker: stock.ticker, week, day };
    f.vol20 = std(i, 20); f.vol60 = std(i, 60); f.vol120 = std(i, 120); f.vr = f.vol20 / f.vol120;
    for (const k of [5, 20, 60, 120]) f[`ret${k}`] = close[i] / close[i - k] - 1;
    f.mom12_1 = close[i - 20] / close[i - 250] - 1;
    let hi = -Infinity, lo = Infinity;
    for (let k = i - 249; k <= i; k++) { if (close[k] > hi) hi = close[k]; if (close[k] < lo) lo = close[k]; }
    f.hi52 = close[i] / hi - 1; f.lo52 = close[i] / lo - 1;
    let v5 = 0; for (let k = i - 4; k <= i; k++) v5 += volume[k];
    const vm = rollingMedianPrev(volume, i - 4, 60);
    f.volsurge5 = vm > 0 ? v5 / 5 / vm : NaN;
    const dv = []; for (let k = i - 19; k <= i; k++) dv.push(close[k] * volume[k]);
    f.ldvol = Math.log(median(dv) + 1); f.lprice = Math.log(close[i]);
    const e = earnIdx[i];
    f.since_earn = e >= 0 ? i - e : NaN; f.earn_react = e >= 0 ? ret[e] : NaN; f.due_in = e >= 0 ? 63 - ((i - e) % 63) : NaN;
    // market context
    const si = spyIndex.get(day);
    f.spy20 = si !== undefined && si >= 20 ? spy.close[si] / spy.close[si - 20] - 1 : NaN;
    f.spyvol20 = si !== undefined && si >= 20 ? spy.vol20[si] : NaN;
    // attention (Wikipedia page views, calendar days)
    const w = stock.views;
    if (w && w.values.length) {
      const k = day - w.start;
      const prior = [];
      for (let q = k - 28; q < k; q++) if (q >= 0 && q < w.values.length && Number.isFinite(w.values[q])) prior.push(Math.log1p(w.values[q]));
      if (prior.length >= 20 && k < w.values.length && Number.isFinite(w.values[k])) {
        const med = median(prior);
        const mad = 1.4826 * median(prior.map((x) => Math.abs(x - med)));
        f.wz = (Math.log1p(w.values[k]) - med) / Math.max(mad, 0.05);
        const last7 = []; for (let q = k - 6; q <= k; q++) if (q >= 0 && Number.isFinite(w.values[q])) last7.push(w.values[q]);
        f.wl7 = last7.length >= 5 ? Math.log1p(last7.reduce((a, b) => a + b, 0) / last7.length) - med : NaN;
        const m28 = []; for (let q = k - 27; q <= k; q++) if (q >= 0 && Number.isFinite(w.values[q])) m28.push(w.values[q]);
        const old = []; for (let q = k - 87; q <= k - 60; q++) if (q >= 0 && Number.isFinite(w.values[q])) old.push(w.values[q]);
        f.wtrend = m28.length >= 20 && old.length >= 20 ? Math.log1p(m28.reduce((a, b) => a + b, 0) / m28.length) - Math.log1p(old.reduce((a, b) => a + b, 0) / old.length) : NaN;
        f.wlevel = med;
      }
    }
    // news (GDELT): trailing 7-day tone and volume against the trailing 60 days
    if (stock.news) {
      const nw = stock.news;
      const mean = (arr, a, b) => { let s = 0, c = 0; for (let q = a; q <= b; q++) { const x = arr.get(q); if (Number.isFinite(x)) { s += x; c++; } } return c ? s / c : NaN; };
      const t7 = mean(nw.tone, day - 6, day), t60 = mean(nw.tone, day - 59, day);
      const v7 = mean(nw.vol, day - 6, day), v60 = mean(nw.vol, day - 59, day);
      f.ntone = t7; f.ntonechg = t7 - t60;
      f.nvol = Math.log(v7 + 1e-6); f.nvolchg = Math.log(v7 + 1e-6) - Math.log(v60 + 1e-6);
    }
    // what happened next (entry at the next open, exit at the close `H` sessions later), minus the market over the same dates
    for (const H of horizons) {
      const x = i + H;
      const s0 = spyIndex.get(days[i + 1]), s1 = x < n ? spyIndex.get(days[x]) : undefined;
      if (x >= n || s0 === undefined || s1 === undefined) { f[`R${H}`] = NaN; f[`z${H}`] = NaN; continue; }
      const R = close[x] / open[i + 1] - 1 - (spy.close[s1] / spy.open[s0] - 1);
      f[`R${H}`] = R;
      f[`z${H}`] = R / (f.vol60 * Math.sqrt(H));
    }
    rows.push(f);
  }
  return rows;
}

// ---------- panel ----------
function prepareSpy(spyBars) {
  const n = spyBars.days.length;
  const spyClose = Float64Array.from(spyBars.close), spyOpen = Float64Array.from(spyBars.open);
  const spyRet = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) spyRet[i] = spyClose[i] / spyClose[i - 1] - 1;
  const vol20 = new Float64Array(n).fill(NaN);
  for (let i = 20; i < n; i++) { let s = 0, ss = 0; for (let k = i - 19; k <= i; k++) { s += spyRet[k]; ss += spyRet[k] ** 2; } const m = s / 20; vol20[i] = Math.sqrt(Math.max(0, ss / 20 - m * m) * (20 / 19)); }
  return { close: spyClose, open: spyOpen, vol20, index: new Map(Array.from(spyBars.days, (d, i) => [d, i])) };
}
function buildPanel(stocks, spyBars, opts = {}) {
  const spy = prepareSpy(spyBars);
  const rows = [];
  for (const s of stocks) rows.push(...stockRows(s, spy, opts));
  return rows;
}
// Rows are kept as columns of 32-bit numbers (a panel of 250,000 weekly rows then takes about 40 MB instead of several hundred)
class Panel {
  constructor() { this.n = 0; this.cap = 4096; this.cols = new Map(); this.tickers = new Set(); }
  grow() {
    this.cap *= 2;
    for (const [k, a] of this.cols) { const b = new Float32Array(this.cap).fill(NaN); b.set(a); this.cols.set(k, b); }
  }
  push(row) {
    if (this.n >= this.cap) this.grow();
    this.tickers.add(row.ticker);
    for (const k in row) {
      if (k === 'ticker') continue;
      let a = this.cols.get(k);
      if (!a) { a = new Float32Array(this.cap).fill(NaN); this.cols.set(k, a); }
      a[this.n] = row[k];
    }
    this.n++;
  }
  col(name) { const a = this.cols.get(name); return a ? a.subarray(0, this.n) : new Float32Array(this.n).fill(NaN); }
}

// The same, but lets the server answer requests every few stocks (the full universe takes tens of seconds)
async function buildPanelAsync(stocks, spyBars, opts = {}) {
  const panel = new Panel();
  const chunk = 40;
  for (let i = 0; i < stocks.length; i += chunk) {
    for (const r of buildPanel(stocks.slice(i, i + chunk), spyBars, opts)) panel.push(r);
    await new Promise((r) => setImmediate(r));
  }
  return panel;
}

// ---------- walk-forward ----------
function walkForward(panel, H, bigCols, dirCols, { startWeek, stepWeeks = 13, embargoWeeks, C = 0.3, minTrain = 3000, maxTrain = 60000 } = {}) {
  const embargo = embargoWeeks ?? Math.ceil((H * 1.5) / 5);
  const week = panel.col('week'), R = panel.col(`R${H}`), z = panel.col(`z${H}`), mom = panel.col('mom12_1'), vol60 = panel.col('vol60'), vol120 = panel.col('vol120');
  let last = -Infinity;
  for (let i = 0; i < panel.n; i++) if (week[i] > last) last = week[i];
  const isBig = (i) => Math.abs(z[i]) >= BIG;
  const out = [];
  for (let a = startWeek; a < last; a += stepWeeks) {
    const trainIdx = [], testIdx = [];
    for (let i = 0; i < panel.n; i++) {
      if (!Number.isFinite(R[i])) continue;
      if (week[i] < a - embargo) trainIdx.push(i); else if (week[i] >= a && week[i] < a + stepWeeks) testIdx.push(i);
    }
    if (trainIdx.length < minTrain || testIdx.length < 100) continue;
    if (trainIdx.length > maxTrain) { const stride = trainIdx.length / maxTrain; const keep = []; for (let q = 0; q < maxTrain; q++) keep.push(trainIdx[Math.floor(q * stride)]); trainIdx.length = 0; for (const k of keep) trainIdx.push(k); }
    const bigCol = bigCols.map((c) => panel.col(c));
    const bigScaler = makeScaler(bigCol.map((c) => trainIdx.map((i) => c[i])));
    const yBig = Float64Array.from(trainIdx, (i) => (isBig(i) ? 1 : 0));
    const m1 = fitLogistic(applyScaler(bigScaler, bigCol, trainIdx), yBig, { C });
    const pb = predictLogistic(m1, applyScaler(bigScaler, bigCol, testIdx));
    const isSize = (i) => Math.abs(R[i]) >= SIZE[H];
    const m3 = fitLogistic(applyScaler(bigScaler, bigCol, trainIdx), Float64Array.from(trainIdx, (i) => (isSize(i) ? 1 : 0)), { C });
    const ps = predictLogistic(m3, applyScaler(bigScaler, bigCol, testIdx));
    let pu = new Float64Array(testIdx.length).fill(0.5);
    if (dirCols.length) {
      const bigTrain = trainIdx.filter(isBig);
      const dirCol = dirCols.map((c) => panel.col(c));
      const dirScaler = makeScaler(dirCol.map((c) => bigTrain.map((i) => c[i])));
      const yUp = Float64Array.from(bigTrain, (i) => (R[i] > 0 ? 1 : 0));
      const m2 = fitLogistic(applyScaler(dirScaler, dirCol, bigTrain), yUp, { C });
      pu = predictLogistic(m2, applyScaler(dirScaler, dirCol, testIdx));
    }
    // only what the reports need is kept for each test row
    testIdx.forEach((i, k) => out.push({ week: week[i], [`R${H}`]: R[i], mom12_1: mom[i], vol60: vol60[i], vol120: vol120[i], ps: ps[k], size: isSize(i) ? 1 : 0, pb: pb[k], pu: pu[k], big: isBig(i) ? 1 : 0, up: R[i] > 0 ? 1 : 0, score: pb[k] * (2 * pu[k] - 1) }));
  }
  return out;
}

// ---------- portfolios ----------
const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
// Rebalance every H/5 weeks: buy the best `q` share of stocks by score (score above zero), sell short the worst (score below zero). Returns one entry per period.
function portfolio(res, scoreOf, H, { q = 0.1, offset = 0, minNames = 5 } = {}) {
  const byWeek = new Map();
  for (const r of res) { const s = scoreOf(r); if (!Number.isFinite(s) || !Number.isFinite(r[`R${H}`])) continue; if (!byWeek.has(r.week)) byWeek.set(r.week, []); byWeek.get(r.week).push([s, r[`R${H}`]]); }
  const k = Math.max(1, Math.round(H / 5));
  const weeks = [...byWeek.keys()].sort((a, b) => a - b);
  const periods = [];
  const borrow = (BORROW * H) / 252;
  for (let w = offset; w < weeks.length; w += k) {
    const g = byWeek.get(weeks[w]);
    if (g.length < 50) continue;
    // rank within the week: only differences between stocks count (a model that is bullish on everything is a market call, not a stock pick)
    const centre = median(g.map((x) => x[0]));
    for (const x of g) x[0] -= centre;
    const m = Math.max(minNames, Math.floor(g.length * q));
    g.sort((a, b) => b[0] - a[0]);
    const top = g.slice(0, m).filter((x) => x[0] > 0), bot = g.slice(-m).filter((x) => x[0] < 0);
    const long = top.length >= minNames ? top.reduce((a, x) => a + clip(x[1], -1, 3), 0) / top.length : NaN;
    const short = bot.length >= minNames ? bot.reduce((a, x) => a + clip(x[1], -1, 3), 0) / bot.length : NaN;
    periods.push({ week: weeks[w], long, short, longNet: long - COST, shortNet: -short - COST - borrow, lsNet: 0.5 * (long - short) - COST - 0.5 * borrow });
  }
  return periods;
}
const mean = (a) => { const x = a.filter(Number.isFinite); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : NaN; };
const sd = (a) => { const x = a.filter(Number.isFinite); if (x.length < 3) return NaN; const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1)); };

// Average over all start offsets (so every week is used once per offset) with a 95% range from resampling blocks of consecutive periods
function evaluate(res, scoreOf, H, { q = 0.1, B = 400, seed = 7 } = {}) {
  const k = Math.max(1, Math.round(H / 5));
  const all = Array.from({ length: k }, (_, off) => portfolio(res, scoreOf, H, { q, offset: off }));
  const pick = (name) => mean(all.map((p) => mean(p.map((x) => x[name]))));
  const first = all[0];
  const sharpe = (() => { const m = mean(first.map((x) => x.lsNet)), s = sd(first.map((x) => x.lsNet)); return s > 0 ? (m / s) * Math.sqrt(252 / H) : null; })();
  // block bootstrap over the first offset's periods, weeks stay in time order so overlapping holds are respected by the offset choice
  let state = seed;
  const rnd = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
  const xs = first.map((x) => x.lsNet).filter(Number.isFinite);
  const boots = [];
  for (let b = 0; b < B && xs.length > 4; b++) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rnd() * xs.length)]; boots.push(s / xs.length); }
  boots.sort((a, b) => a - b);
  const byYear = {};
  for (const p of first) { const y = new Date(p.week * 7 * DAY - 3 * DAY).getUTCFullYear(); (byYear[y] ||= []).push(p.lsNet); }
  return {
    periods: first.length, lsNet: pick('lsNet'), longNet: pick('longNet'), shortNet: pick('shortNet'),
    hit: mean(first.map((x) => (x.lsNet > 0 ? 1 : 0))), sharpe, ci: boots.length ? [boots[Math.floor(0.025 * (boots.length - 1))], boots[Math.ceil(0.975 * (boots.length - 1))]] : null,
    byYear: Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, { n: v.length, mean: mean(v) }])),
  };
}

// Every number here comes from the test rows only (each fold is scored by a model trained on earlier weeks, with an embargo); nothing is scored on rows it was trained on.
const quarterMeanAuc = (res, label, score) => {
  const by = new Map();
  for (const r of res) { const q = Math.floor(r.week / 13); if (!by.has(q)) by.set(q, []); by.get(q).push(r); }
  const a = [...by.values()].map((g) => auc(Float64Array.from(g, label), Float64Array.from(g, score))).filter((x) => x !== null);
  return mean(a);
};
const topLift = (res, label, score) => {
  const cut = quantileSorted(sorted(Float64Array.from(res, score)), 0.9);
  const top = res.filter((r) => score(r) >= cut);
  const base = mean(res.map(label));
  return top.length && base > 0 ? mean(top.map(label)) / base : null;
};
const stage1Report = (res, H) => {
  const rel = (r) => r.big, sz = (r) => r.size;
  return {
    n: res.length, base: mean(res.map(rel)), auc: auc(Float64Array.from(res, rel), Float64Array.from(res, (r) => r.pb)), lift: topLift(res, rel, (r) => r.pb), quarterAuc: quarterMeanAuc(res, rel, (r) => r.pb),
    size: {
      threshold: SIZE[H], base: mean(res.map(sz)), auc: auc(Float64Array.from(res, sz), Float64Array.from(res, (r) => r.ps)), lift: topLift(res, sz, (r) => r.ps), quarterAuc: quarterMeanAuc(res, sz, (r) => r.ps),
      volatilityOnlyAuc: auc(Float64Array.from(res, sz), Float64Array.from(res, (r) => r.vol120)), // the benchmark: a single number, the stock's own volatility over 120 sessions
    },
  };
};

// Reliability of the big-shift probability: ten equal groups of test rows by predicted chance, with the share that really had a big shift
function calibration(res) {
  const order = Array.from({ length: res.length }, (_, i) => i).sort((a, b) => res[a].ps - res[b].ps);
  const groups = [];
  for (let g = 0; g < 10; g++) {
    const part = order.slice(Math.floor((g * order.length) / 10), Math.floor(((g + 1) * order.length) / 10));
    if (part.length) groups.push({ predicted: mean(part.map((i) => res[i].ps)), actual: mean(part.map((i) => res[i].size)), n: part.length });
  }
  return groups;
}
const stage2Report = (res) => {
  const big = res.filter((r) => r.big === 1);
  const byQuarter = new Map();
  for (const r of big) { const q = Math.floor(r.week / 13); if (!byQuarter.has(q)) byQuarter.set(q, []); byQuarter.get(q).push(r); }
  const quarterAucs = [...byQuarter.values()].map((g) => auc(Float64Array.from(g, (r) => r.up), Float64Array.from(g, (r) => r.pu))).filter((x) => x !== null);
  return { n: big.length, upRate: mean(big.map((r) => r.up)), auc: auc(Float64Array.from(big, (r) => r.up), Float64Array.from(big, (r) => r.pu)), quarterAuc: mean(quarterAucs), quarters: quarterAucs.length };
};

// ---------- the lab ----------
// stocks: [{ ticker, addedDay, removedDay (day numbers or null), bars: { days, open, close, volume }, views: { start (day number), values } | null, news: { tone: Map, vol: Map } | null }]
// spyBars: { days, open, close }. All days are day numbers since 1970-01-01.
async function runLab2({ stocks, spy, horizons = [20, 60], startWeek, B = 400, sets } = {}, opts = {}) {
  const rows = await buildPanelAsync(stocks, spy, { horizons });
  if (rows.n < 5000) return { status: 'insufficient', reason: `only ${rows.n} weekly observations` };
  const weeksSorted = [...new Set(rows.col('week'))].sort((a, b) => a - b);
  const first = startWeek ?? weeksSorted[Math.floor(weeksSorted.length * 0.4)]; // the first 40% of the history is training only
  const configs = sets || [
    { id: 'price', label: 'Prices and volume only', big: FEATURES.price, dir: DIRECTION.filter((c) => FEATURES.price.includes(c)) },
    { id: 'earn', label: '+ results-day estimate', big: [...FEATURES.price, ...FEATURES.earn], dir: DIRECTION.filter((c) => FEATURES.price.includes(c) || c === 'earn_react') },
    { id: 'wiki', label: '+ Wikipedia attention', big: [...FEATURES.price, ...FEATURES.earn, ...FEATURES.wiki], dir: DIRECTION.filter((c) => !c.startsWith('n')) },
  ];
  const out = { status: 'ok', panel: opts.keepPanel ? rows : undefined, generatedAt: new Date().toISOString(), observations: rows.n, stocks: rows.tickers.size, firstTestWeek: first, horizons: {} };
  for (const H of horizons) {
    const entry = { H, models: [], baselines: [] };
    for (const cfg of configs) {
      await new Promise((r) => setImmediate(r)); // let the server answer requests between the heavy steps
      const res = walkForward(rows, H, cfg.big, cfg.dir, { startWeek: first });
      if (!res.length) continue;
      if (cfg === configs[0]) entry.calibration = calibration(res);
      entry.models.push({ id: cfg.id, label: cfg.label, stage1: stage1Report(res, H), stage2: stage2Report(res), all: evaluate(res, (r) => r.score, H, { B }), directionOnly: evaluate(res, (r) => r.pu - 0.5, H, { B }) });
      if (cfg === configs[0]) entry.res = res;
    }
    const res = entry.res;
    if (res) {
      const centred = (name, sign = 1) => {
        const byWeek = new Map();
        for (const r of res) { if (!byWeek.has(r.week)) byWeek.set(r.week, []); byWeek.get(r.week).push(r[name]); }
        const med = new Map([...byWeek].map(([w, v]) => [w, median(v.filter(Number.isFinite))]));
        return (r) => sign * (r[name] - med.get(r.week));
      };
      let st = 5;
      const rand = () => { st = (st * 1664525 + 1013904223) % 4294967296; return st / 4294967296 - 0.5; };
      entry.baselines = [
        { id: 'momentum', label: 'Buy past winners, sell past losers (12-1 month momentum)', ...evaluate(res, centred('mom12_1'), H, { B }) },
        { id: 'lowvol', label: 'Buy the calmest, sell the jumpiest', ...evaluate(res, centred('vol60', -1), H, { B }) },
        { id: 'random', label: 'Random scores (what luck and costs alone give)', ...evaluate(res, () => rand(), H, { B }) },
      ];
    }
    delete entry.res;
    out.horizons[H] = entry;
  }
  return out;
}

// ---------- today's chance of a big move ----------
// Fits the stage 1 model (price and volume features only) on every labelled row and scores stocks as they are today. H is in sessions.
function fitBigMove(panel, H, { cols = FEATURES.price, maxTrain = 80000, C = 0.3 } = {}) {
  const R = panel.col(`R${H}`);
  const idx = [];
  for (let i = 0; i < panel.n; i++) if (Number.isFinite(R[i])) idx.push(i);
  if (idx.length > maxTrain) { const stride = idx.length / maxTrain; const keep = []; for (let q = 0; q < maxTrain; q++) keep.push(idx[Math.floor(q * stride)]); idx.length = 0; for (const k of keep) idx.push(k); }
  const columns = cols.map((c) => panel.col(c));
  const scaler = makeScaler(columns.map((c) => idx.map((i) => c[i])));
  const y = Float64Array.from(idx, (i) => (Math.abs(R[i]) >= SIZE[H] ? 1 : 0));
  const model = fitLogistic(applyScaler(scaler, columns, idx), y, { C });
  let base = 0; for (const v of y) base += v;
  return { cols, scaler, model, base: base / y.length, n: idx.length };
}
function scoreBigMove(fit, row) {
  const columns = fit.cols.map((c) => [row[c] === undefined ? NaN : row[c]]);
  return predictLogistic(fit.model, applyScaler(fit.scaler, columns, [0]))[0];
}

module.exports = { SIZE, prepareSpy, fitBigMove, scoreBigMove, runLab2, buildPanel, buildPanelAsync, stockRows, walkForward, portfolio, evaluate, fitLogistic, predictLogistic, auc, earningsFlags, weekOf, FEATURES, DIRECTION, COST };
