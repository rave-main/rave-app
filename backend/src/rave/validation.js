// Does a spike in attention come BEFORE an unusual price move, early enough to act on?
//
// Pure functions, no database. Tests use synthetic data where the true answer is known (nothing, a volatility effect,
// a drift, a price move that LEADS attention); the same code then runs on real data (research.js).
//
// Design choices that keep the answer honest:
//  - Signals come from rateDaily (scoring.js), the very function the live site uses.
//  - Entry is at the OPEN of the first trading day at least `lagDays` calendar days after the signal day, never the
//    close of the day the spike happened. lagDays=2 is the conservative default (page views for a day are only
//    complete after that day, and a person needs time to act); lagDays=1 is the optimistic case.
//  - Prices are compared with SPY over the same window ("abnormal" return), so a rising market is not an effect.
//  - Spike days are compared with the same stock's ordinary days, not with other stocks.
//  - Significance by permutation (shuffle which days count as spikes) and bootstrap intervals, not formulas that
//    assume normal data.
const { rateDaily } = require('./scoring');
const { median } = require('./stats');

const DAY = 86400000;
const HORIZONS = [1, 5, 20];
const LABEL_RANK = { Rising: 1, Hot: 2, Extreme: 3 };

const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d, n) => new Date(dayMs(d) + n * DAY).toISOString().slice(0, 10);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quantile = (sorted, q) => {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo);
};

// ---------- signals ----------
// values[k] = attention on calendar day startDay + k (null when missing). Returns the first day of each Hot+ episode.
function findEvents(values, startDay, { minLabel = 'Hot', cooldownDays = 10 } = {}) {
  const events = [];
  let last = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const r = rateDaily(values, i);
    if (r && (LABEL_RANK[r.label] || 0) >= LABEL_RANK[minLabel] && i - last > cooldownDays) {
      events.push({ day: addDays(startDay, i), index: i, label: r.label, ratio: r.ratio, z: r.z });
      last = i;
    }
  }
  return events;
}

// ---------- prices ----------
function indexPrices(rows) {
  const days = rows.map((r) => r.day);
  const idx = new Map(days.map((d, i) => [d, i]));
  return { rows, days, idx, n: rows.length };
}

// first trading index whose day is >= `day` (binary search), or -1
function firstTradingOnOrAfter(px, day) {
  let lo = 0;
  let hi = px.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (px.days[mid] < day) lo = mid + 1;
    else hi = mid;
  }
  return lo < px.n ? lo : -1;
}

// Outcomes of entering at the open of trading day e and exiting at the close of the h-th trading day (day e is day 1)
function outcomeAt(px, bench, e, h) {
  const x = px.rows;
  if (e < 0 || e + h - 1 >= px.n) return null;
  const exitDay = x[e + h - 1].day;
  const b0 = bench.idx.get(x[e].day);
  const b1 = bench.idx.get(exitDay);
  if (b0 === undefined || b1 === undefined || !(x[e].open > 0) || !(bench.rows[b0].open > 0)) return null;
  const ret = x[e + h - 1].close / x[e].open - 1;
  const benchRet = bench.rows[b1].close / bench.rows[b0].open - 1;
  const abn = ret - benchRet;
  let vol = null;
  if (e >= 60) {
    const before = median(x.slice(e - 60, e).map((r) => r.volume));
    if (before > 0) vol = mean(x.slice(e, e + h).map((r) => r.volume)) / before;
  }
  return { ret, abn, absAbn: Math.abs(abn), vol };
}

// ---------- event study ----------
// BASELINE = the stock's UNCONDITIONAL average over all its windows. An earlier version compared event windows with
// windows "far from any event"; but every attention spike is either an event or inside an event's cool-down, so those
// controls were windows with no spike activity at all, and any contemporaneous link between news and volatility showed
// up as a fake effect (testing caught it: 4 of 16 worlds falsely significant). The unconditional baseline errs the other
// way (windows just BEFORE an event hold the spike-day news but are in the baseline, not in the event windows), so it can
// understate a real effect but cannot invent one.
//
// The null distribution is a PLACEBO SHIFT: each stock's attention signal is rotated by a random number of days against
// its prices and the WHOLE procedure (spike detection, cool-down, control exclusion) is run again. Every selection effect
// of the procedure is therefore part of the null, so a spike's neighbourhood being removed from the controls cannot
// masquerade as an effect (an earlier version drew random days from a pool instead and was biased, caught by testing).
const METRICS = ['abn', 'absAbn', 'vol'];

function prepareTicker(s, benchPx, { horizons, lagDays, minLabel }) {
  const px = indexPrices(s.prices);
  const nCal = s.values.length;
  const hot = [];
  for (let i = 0; i < nCal; i++) {
    const r = rateDaily(s.values, i);
    if (r && (LABEL_RANK[r.label] || 0) >= LABEL_RANK[minLabel]) hot.push(i);
  }
  // trading index of the entry for a signal on calendar day c: the first trading day on or after c + lagDays
  const entryOfCal = new Int32Array(nCal);
  for (let c = 0; c < nCal; c++) entryOfCal[c] = firstTradingOnOrAfter(px, addDays(s.startDay, c + lagDays));
  const metricsAt = {};
  for (const h of horizons) {
    const arrs = { abn: new Float64Array(px.n).fill(NaN), absAbn: new Float64Array(px.n).fill(NaN), vol: new Float64Array(px.n).fill(NaN) };
    for (let e = 0; e < px.n; e++) {
      const o = outcomeAt(px, benchPx, e, h);
      if (!o) continue;
      arrs.abn[e] = o.abn; arrs.absAbn[e] = o.absAbn; if (o.vol !== null) arrs.vol[e] = o.vol;
    }
    const tot = {};
    for (const m of METRICS) {
      let sum = 0, n = 0, pos = 0;
      for (let e = 0; e < px.n; e++) { const x = arrs[m][e]; if (!Number.isNaN(x)) { sum += x; n++; if (x > 0) pos++; } }
      tot[m] = { sum, n, pos };
    }
    metricsAt[h] = { arrs, tot };
  }
  return { ticker: s.ticker, n: px.n, nCal, hot, entryOfCal, metricsAt, mark: new Int32Array(px.n) };
}

// Events for one shift of the attention signal: first day of each Hot+ episode (cool-down), then their entry days
function entriesForShift(t, shift, { cooldownDays }) {
  const hot = shift === 0 ? t.hot : t.hot.map((c) => (c + shift) % t.nCal).sort((a, b) => a - b);
  const entries = [];
  let last = -Infinity;
  for (const c of hot) {
    if (c - last > cooldownDays) {
      last = c;
      const e = t.entryOfCal[c];
      if (e >= 0 && !entries.includes(e)) entries.push(e);
    }
  }
  return entries;
}

// For one ticker, one shift, one horizon: the events' outcomes and the ordinary-day mean (windows near events excluded)
function tickerSample(t, entries, h, { excludeWindow }) {
  const { arrs, tot } = t.metricsAt[h];
  const excluded = [];
  if (excludeWindow !== null && excludeWindow !== undefined) {
    const stamp = (t.stamp = (t.stamp || 0) + 1);
    for (const e of entries) for (let k = -excludeWindow; k <= excludeWindow; k++) {
      const i = e + k;
      if (i >= 0 && i < t.n && t.mark[i] !== stamp) { t.mark[i] = stamp; excluded.push(i); }
    }
  }
  const out = {};
  for (const m of METRICS) {
    const a = arrs[m];
    let sum = tot[m].sum, n = tot[m].n, pos = tot[m].pos;
    for (const i of excluded) if (!Number.isNaN(a[i])) { sum -= a[i]; n--; if (a[i] > 0) pos--; }
    if (n < 30) { out[m] = null; continue; }
    const ev = entries.filter((e) => !Number.isNaN(a[e])).map((e) => a[e]);
    out[m] = ev.length ? { ev, ctlMean: sum / n, ctlHit: pos / n } : null;
  }
  return out;
}

const pooledStat = (parts) => {
  let sum = 0, n = 0;
  for (const p of parts) for (const v of p.ev) { sum += v - p.ctlMean; n++; }
  return n ? sum / n : NaN;
};

function studyMetric(prepared, h, metric, observed, { B, rng, oneSided, nullStats }) {
  const parts = observed.map((o) => o[metric]).filter(Boolean);
  const excess = parts.flatMap((p) => p.ev.map((v) => v - p.ctlMean));
  if (!excess.length) return null;
  const stat = mean(excess);
  const boots = [];
  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let k = 0; k < excess.length; k++) sum += excess[Math.floor(rng() * excess.length)];
    boots.push(sum / excess.length);
  }
  boots.sort((a, b) => a - b);
  const nulls = nullStats[`${h}|${metric}`].filter((x) => !Number.isNaN(x));
  const extreme = nulls.filter((x) => (oneSided ? x >= stat : Math.abs(x) >= Math.abs(stat))).length;
  const evRaw = parts.flatMap((p) => p.ev);
  const weightedCtl = (f) => mean(parts.flatMap((p) => p.ev.map(() => f(p))));
  return {
    n: excess.length,
    tickers: parts.length,
    mean: stat, // average excess over the stock's own ordinary days
    median: median(excess),
    ci: [quantile(boots, 0.025), quantile(boots, 0.975)],
    p: (extreme + 1) / (nulls.length + 1),
    nullDraws: nulls.length,
    eventMean: mean(evRaw),
    controlMean: weightedCtl((p) => p.ctlMean),
    hitRate: metric === 'abn' ? mean(evRaw.map((x) => (x > 0 ? 1 : 0))) : null,
    controlHitRate: metric === 'abn' ? weightedCtl((p) => p.ctlHit) : null,
  };
}

// series: [{ ticker, startDay, values (daily attention), prices: [{day, open, close, volume}] }], bench: SPY rows
// excludeWindow: null (default) = unconditional baseline; a number would drop windows within that many days of an event
const tick = () => new Promise((resolve) => setImmediate(resolve)); // let the server answer requests between chunks of work

async function eventStudy({ series, bench, horizons = HORIZONS, lagDays = 2, minLabel = 'Hot', cooldownDays = 10, excludeWindow = null, B = 1000, seed = 1 }) {
  const benchPx = indexPrices(bench);
  const rng = makeRng(seed);
  const cfg = { cooldownDays, excludeWindow };
  const prepared = series.map((s) => prepareTicker(s, benchPx, { horizons, lagDays, minLabel }));

  const sampleAll = (shiftOf) => {
    const perH = {};
    for (const h of horizons) perH[h] = [];
    for (const t of prepared) {
      const entries = entriesForShift(t, shiftOf(t), cfg);
      if (!entries.length) continue;
      for (const h of horizons) perH[h].push(tickerSample(t, entries, h, cfg));
    }
    return perH;
  };
  const observedAll = sampleAll(() => 0);
  const eventCount = prepared.reduce((n, t) => n + entriesForShift(t, 0, cfg).length, 0);

  // null: B random rotations of the attention signals (at least 60 days away from the true alignment)
  const nullStats = {};
  for (const h of horizons) for (const m of METRICS) nullStats[`${h}|${m}`] = [];
  for (let b = 0; b < B; b++) {
    const perH = sampleAll((t) => 60 + Math.floor(rng() * Math.max(1, t.nCal - 120)));
    for (const h of horizons) for (const m of METRICS) nullStats[`${h}|${m}`].push(pooledStat(perH[h].map((o) => o[m]).filter(Boolean)));
    if (b % 20 === 19) await tick();
  }

  const results = {};
  for (const h of horizons) {
    const opts = { B: Math.min(B, 1000), rng, nullStats };
    results[h] = {
      direction: studyMetric(prepared, h, 'abn', observedAll[h], { ...opts, oneSided: false }), // average return differs from ordinary days
      size: studyMetric(prepared, h, 'absAbn', observedAll[h], { ...opts, oneSided: true }), // moves are LARGER than ordinary days
      volume: studyMetric(prepared, h, 'vol', observedAll[h], { ...opts, oneSided: true }),
    };
  }
  return { lagDays, minLabel, tickersWithEvents: observedAll[horizons[0]].length, events: eventCount, results };
}

// ---------- lead-lag ----------
function pearson(x, y) {
  const n = x.length;
  if (n < 30) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

// Correlation of the attention shock on day t with the price outcome on trading day t+k. k>0: attention LEADS price;
// k<0: price leads attention. Outcomes: size of the market-adjusted daily move, and volume relative to normal.
async function leadLag({ series, bench, maxLag = 10, B = 500, seed = 2 }) {
  const benchPx = indexPrices(bench);
  const perTicker = [];
  for (const s of series) {
    const px = indexPrices(s.prices);
    const t0 = dayMs(s.startDay);
    const shock = [];
    const size = [];
    const volu = [];
    for (let i = 1; i < px.n; i++) {
      const d = Math.round((dayMs(px.days[i]) - t0) / DAY);
      const v = s.values[d];
      const prior = [];
      for (let k = 1; k <= 7; k++) if (s.values[d - k] != null) prior.push(s.values[d - k]);
      const bi = benchPx.idx.get(px.days[i]);
      const bp = benchPx.idx.get(px.days[i - 1]);
      let sh = null, sz = null, vl = null;
      if (v != null && prior.length >= 4) sh = Math.log((v + 1) / (median(prior) + 1));
      if (bi !== undefined && bp !== undefined) sz = Math.abs(px.rows[i].close / px.rows[i - 1].close - benchPx.rows[bi].close / benchPx.rows[bp].close);
      if (i >= 61) { const base = median(px.rows.slice(i - 61, i - 1).map((r) => r.volume)); if (base > 0) vl = Math.log(px.rows[i].volume / base); }
      shock.push(sh); size.push(sz); volu.push(vl);
    }
    perTicker.push({ shock, size, volu });
  }
  const rng = makeRng(seed);
  const rows = [];
  for (let k = -maxLag; k <= maxLag; k++) {
    const per = { size: [], volume: [] };
    for (const t of perTicker) {
      for (const [name, series2] of [['size', t.size], ['volume', t.volu]]) {
        const xs = [], ys = [];
        for (let i = 0; i < t.shock.length; i++) {
          const j = i + k;
          if (j < 0 || j >= series2.length || t.shock[i] === null || series2[j] === null) continue;
          xs.push(t.shock[i]); ys.push(series2[j]);
        }
        const r = pearson(xs, ys);
        if (r !== null) per[name].push(r);
      }
    }
    const summarise = (rs) => {
      if (!rs.length) return null;
      const m = mean(rs);
      const boots = [];
      for (let b = 0; b < B; b++) { let s = 0; for (let q = 0; q < rs.length; q++) s += rs[Math.floor(rng() * rs.length)]; boots.push(s / rs.length); }
      boots.sort((a, b) => a - b);
      return { r: m, ci: [quantile(boots, 0.025), quantile(boots, 0.975)], tickers: rs.length };
    };
    rows.push({ lag: k, size: summarise(per.size), volume: summarise(per.volume) });
    await tick();
  }
  return rows;
}

// Plain-language verdict from the pre-specified tests: size and direction of the move 5 trading days after entry.
function verdict(study, { minEvents = 30, alpha = 0.05 } = {}) {
  const r5 = study.results[5];
  if (!r5 || !r5.size || r5.size.n < minEvents) {
    const n = r5?.size?.n || 0;
    return { level: 'insufficient', headline: `Not enough spikes yet to say anything (${n} so far, ${minEvents} needed).`, details: [] };
  }
  const bonferroni = alpha / 2; // two primary questions: is the move larger, and does it have a direction
  const sizeSig = r5.size.p < bonferroni && r5.size.mean > 0;
  const dirSig = r5.direction.p < bonferroni;
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  const details = [
    `Size of move over the next 5 trading days: ${pct(r5.size.eventMean)} after a spike vs ${pct(r5.size.controlMean)} on ordinary days (difference ${pct(r5.size.mean)}, 95% range ${pct(r5.size.ci[0])} to ${pct(r5.size.ci[1])}, p = ${r5.size.p.toFixed(3)}).`,
    `Direction: average market-adjusted return ${pct(r5.direction.eventMean)} after a spike vs ${pct(r5.direction.controlMean)} on ordinary days (difference ${pct(r5.direction.mean)}, 95% range ${pct(r5.direction.ci[0])} to ${pct(r5.direction.ci[1])}, p = ${r5.direction.p.toFixed(3)}); ${(r5.direction.hitRate * 100).toFixed(0)}% of spikes were followed by a gain vs ${(r5.direction.controlHitRate * 100).toFixed(0)}% of ordinary days.`,
  ];
  if (sizeSig && dirSig) return { level: 'both', headline: `Spikes were followed by larger AND directional price moves (${r5.direction.mean > 0 ? 'up' : 'down'}), at an entry ${study.lagDays} days after the spike.`, details };
  if (sizeSig) return { level: 'size', headline: `Spikes were followed by larger price moves, but not in a consistent direction: attention predicts how much, not which way.`, details };
  if (dirSig) return { level: 'direction', headline: `Spikes were followed by a ${r5.direction.mean > 0 ? 'rise' : 'fall'} in price, without larger moves overall.`, details };
  return { level: 'none', headline: `No evidence that these spikes precede unusual price moves when entering ${study.lagDays} days after the signal.`, details };
}

module.exports = { findEvents, indexPrices, firstTradingOnOrAfter, outcomeAt, eventStudy, leadLag, verdict, pearson, makeRng, addDays, HORIZONS };
