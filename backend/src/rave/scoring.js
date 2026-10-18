// RAVE scoring: how unusual is a stock's Reddit attention right now, over short / medium / long horizons?
//
// ApeWisdom `mentions` is a rolling 24-hour count, so every point already covers a full day (no hour-of-day
// effect). A stock is compared with ITS OWN history. Two views are computed: raw mentions, and mentions adjusted to
// a typical-sized market day, which removes market-wide waves. Labels use the adjusted view when available.
// All thresholds live in CONFIG so a change is a new version, and backtests can use exactly what runs live.
const { median, scaledMad } = require('./stats');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const CONFIG = {
  version: 'v1',
  minLevel: 10, // mentions per 24h below which a stock is never flagged (tiny counts are noise)
  minScale: 0.05, // floor for the spread in log space (5%) so a flat history cannot make z explode
  lowVolume: 5, // a stock that typically gets fewer mentions a day than this cannot be rated reliably
  spreadDays: 28, // days of same-time-of-day observations used to estimate day-to-day variation
  thresholds: [
    { label: 'Extreme', ratio: 3, z: 4 },
    { label: 'Hot', ratio: 2, z: 3 },
    { label: 'Rising', ratio: 1.5, z: 2 },
  ],
  short: { baselineDays: 8, minSpanDays: 2, weeklyLags: 8, minWeeklyLags: 4, toleranceMs: 3 * HOUR, persistenceGapMs: 20 * 60 * 1000 },
  medium: { currentDays: 7, minCurrent: 5, baselineFromDay: 7, baselineDays: 84, minBaseline: 28, toleranceMs: 3 * HOUR },
  long: { currentDays: 28, minCurrent: 20, baselineFromDay: 28, baselineDays: 730, minBaseline: 28, toleranceMs: 3 * HOUR },
};

// Reddit readings are 30 minutes apart (a rolling 24h count); Wikipedia views are one complete day per point.
const PROFILES = {
  reddit: { noun: 'mentions', shortWindow: 'the last 24 hours', persistence: true, rankInfo: true },
  wiki: { noun: 'page views', shortWindow: 'the latest full day', persistence: false, rankInfo: false },
};

const rank = (label) => ['Quiet', 'Rising', 'Hot', 'Extreme'].indexOf(label); // 'Low volume' ranks like unrated (-1)
const fmt = (n) => (n >= 100 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 10) / 10));
const x = (ratio) => `${fmt(ratio)}×`;

// series: points sorted by time: { t, mentions, market, ranked, rank, rank24hAgo, mentions24hAgo }
// `market` is the total mentions across the leaderboard at that time (null if unknown).
function prepare(series) {
  return series;
}

// Nearest point to `target` within `tol`, by binary search (series is sorted)
function pointNear(series, target, tol) {
  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t < target) lo = mid + 1;
    else hi = mid;
  }
  let best = null;
  for (const i of [lo - 1, lo]) {
    const p = series[i];
    if (p && Math.abs(p.t - target) <= tol && (!best || Math.abs(p.t - target) < Math.abs(best.t - target))) best = p;
  }
  return best;
}

// One point per day-lag (now - k days), skipping days with no data
function dailyPoints(series, now, fromDay, toDay, tol) {
  const out = [];
  for (let k = fromDay; k < toDay; k++) {
    const p = pointNear(series, now - k * DAY, tol);
    if (p) out.push(p);
  }
  return out;
}

// Compare a current value with baseline values: ratio to the baseline median, and a robust z-score on the log scale.
//  - the centre is the median of `baseline`;
//  - the spread comes from `spread` (one value per day, so independent observations), not from `baseline`, whose
//    points overlap heavily; it is floored by the Poisson noise inherent to small counts (about 1/sqrt(count));
//  - z is divided by sqrt(1 + 1.57/nDays) because the centre itself is only estimated from nDays independent days.
function compare(current, baseline, { floor, spread, countBase, nDays }) {
  const base = median(baseline);
  const logs = baseline.map((v) => Math.log1p(v));
  const spreadLogs = (spread && spread.length >= 3 ? spread : baseline).map((v) => Math.log1p(v));
  const scale = Math.max(scaledMad(spreadLogs), CONFIG.minScale, 1 / Math.sqrt(Math.max(countBase, 0) + 1));
  const inflate = Math.sqrt(1 + 1.57 / Math.max(nDays, 1));
  return {
    current,
    baselineMedian: base,
    ratio: current / Math.max(base, floor),
    z: (Math.log1p(current) - median(logs)) / (scale * inflate),
    n: baseline.length,
  };
}

function viewOf(currentPoints, baselinePoints, { spreadPoints = null, nDays } = {}) {
  const med = (arr) => median(arr);
  const countBase = med(baselinePoints.map((p) => p.mentions));
  const run = (get, floor, extra = {}) =>
    compare(med(currentPoints.map(get)), baselinePoints.map(get), { floor, spread: spreadPoints && spreadPoints.map(get), countBase, nDays, ...extra });
  const raw = run((p) => p.mentions, 1);

  // Market adjustment: restate each point's mentions as what it would be on a typical-sized market day (the
  // baseline's median leaderboard total), so a market-wide wave cancels out. The result stays in "mentions",
  // which is what the log scale and the Poisson floor expect.
  const known = (pts) => pts.length > 0 && pts.every((p) => p.market > 0);
  let adjusted = null;
  let market = null;
  if (known(currentPoints) && known(baselinePoints) && (!spreadPoints || known(spreadPoints))) {
    const typical = med(baselinePoints.map((p) => p.market));
    adjusted = run((p) => (p.mentions * typical) / p.market, 1);
    market = run((p) => p.market, 1, { countBase: 1e9 });
  }
  return { raw, adjusted, market };
}

function labelFor(view, level) {
  const m = view.adjusted || view.raw;
  const hit = level >= CONFIG.minLevel ? CONFIG.thresholds.find((t) => m.ratio >= t.ratio && m.z >= t.z) : null;
  if (hit) return hit.label;
  // Too few mentions to tell a real change from chance: say so rather than a falsely reassuring "Quiet"
  return view.raw.baselineMedian < CONFIG.lowVolume && level < CONFIG.minLevel ? 'Low volume' : 'Quiet';
}

function confidenceOf(coverage) {
  return coverage >= 1 ? 'high' : coverage >= 0.5 ? 'medium' : 'low';
}

function describe({ horizon, window, baselineText, view, label, latest, rankText, noun = 'mentions' }) {
  const { raw, adjusted, market } = view;
  const parts = [
    `${latest.ticker ? `${latest.ticker}: ` : ''}${x(raw.ratio)} normal over ${window} (${fmt(raw.current)} ${noun} vs a typical ${fmt(raw.baselineMedian)}, based on ${baselineText}).`,
    `That is ${fmt(Math.abs(raw.z))} robust standard deviations ${raw.z >= 0 ? 'above' : 'below'} normal.`,
  ];
  if (adjusted && market) {
    parts.push(
      `Overall Reddit stock chatter is ${x(market.ratio)} normal, so adjusted for that it is ${x(adjusted.ratio)} normal (z ${fmt(adjusted.z)}).`
    );
  }
  if (label === 'Low volume') {
    parts.push(`It typically gets fewer than ${CONFIG.lowVolume} ${noun} a day, too few to tell a real change from chance, so it is not rated.`);
  }
  if (rankText) parts.push(rankText);
  parts.push(`Label: ${label}.`);
  return parts.join(' ');
}

function rankText(latest) {
  if (!latest.ranked) return 'Not on the leaderboard right now.';
  if (latest.rank24hAgo) return `Rank #${latest.rank} (was #${latest.rank24hAgo} a day ago).`;
  return `Rank #${latest.rank}.`;
}

function warmingUp(horizon, reason, extra = {}) {
  return { horizon, status: 'warming_up', label: 'Warming up', confidence: 'low', coverage: 0, raw: null, adjusted: null, market: null, explanation: reason, ...extra };
}

function scoreShort(series, ticker, profile = PROFILES.reddit) {
  const cfg = CONFIG.short;
  const latest = series[series.length - 1];
  const now = latest.t;

  // Like for like: same hour and weekday over previous weeks, once there are enough weeks of history
  let baseline = [];
  let lags = 0;
  for (let k = 1; k <= cfg.weeklyLags; k++) {
    const near = series.filter((p) => Math.abs(p.t - (now - 7 * k * DAY)) <= cfg.toleranceMs);
    if (near.length) {
      lags++;
      baseline.push(...near);
    }
  }
  let baselineText;
  let coverage;
  if (lags >= cfg.minWeeklyLags) {
    baselineText = `the same weekday and hour over the previous ${lags} weeks`;
    coverage = 1;
  } else {
    baseline = series.filter((p) => p.t > now - cfg.baselineDays * DAY && p.t <= now - DAY);
    const spanDays = baseline.length ? (now - baseline[0].t) / DAY : 0;
    if (!baseline.length || baseline[0].t > now - (cfg.minSpanDays + 1) * DAY) {
      const prior = latest.mentions24hAgo;
      const hint = prior > 0 ? ` For now, ${ticker || 'it'} has ${fmt(latest.mentions)} mentions vs ${fmt(prior)} a day ago (${x(latest.mentions / prior)}), as reported by ApeWisdom.` : '';
      const have = Math.max(0, Math.round(((now - series[0].t) / DAY) * 10) / 10);
      return warmingUp('short', `Only ${have} ${have === 1 ? 'day' : 'days'} of history so far; at least ${cfg.minSpanDays + 1} are needed for a baseline, 7 for a reliable one.${hint}`, {
        dayOverDay: prior > 0 ? latest.mentions / prior : null,
      });
    }
    baselineText = `the previous ${Math.min(7, Math.round(spanDays))} days`;
    // A week of mixed weekdays cannot compare like for like, so confidence tops out at "medium" until the
    // same-weekday-and-hour baseline becomes available (4+ weeks of history)
    coverage = 0.75 * Math.min(1, spanDays / 7);
  }

  const spreadPoints = dailyPoints(series, now, 1, CONFIG.spreadDays + 1, cfg.toleranceMs);
  const nDays = lags >= cfg.minWeeklyLags ? lags : Math.max(1, Math.min(7, Math.round((now - baseline[0].t) / DAY)));
  const view = viewOf([latest], baseline, { spreadPoints, nDays });
  let label = labelFor(view, latest.mentions);
  const result = { horizon: 'short', status: 'ok', confidence: confidenceOf(coverage), coverage, ...view };

  // A single-snapshot glitch must not flag a stock: the previous snapshot has to agree at least at Rising level
  const prev = [...series].reverse().find((p) => p.t <= now - cfg.persistenceGapMs);
  if (profile.persistence && rank(label) > 1 && prev) {
    const prevLabel = labelFor(viewOf([prev], baseline, { spreadPoints, nDays }), prev.mentions);
    if (rank(prevLabel) < 1) {
      label = 'Rising';
      result.unconfirmed = true;
    }
  }
  result.label = label;
  result.explanation = describe({ horizon: 'short', window: profile.shortWindow, baselineText, view, label, latest: { ...latest, ticker }, rankText: profile.rankInfo ? rankText(latest) : '', noun: profile.noun }) +
    (result.unconfirmed ? ' Capped at Rising until the next snapshot confirms it.' : '');
  return result;
}

function scoreDaily(series, ticker, horizon, profile = PROFILES.reddit) {
  const cfg = CONFIG[horizon];
  const latest = series[series.length - 1];
  const now = latest.t;
  const current = dailyPoints(series, now, 0, cfg.currentDays, cfg.toleranceMs);
  const baseline = dailyPoints(series, now, cfg.baselineFromDay, cfg.baselineFromDay + cfg.baselineDays, cfg.toleranceMs);
  if (current.length < cfg.minCurrent || baseline.length < cfg.minBaseline) {
    return warmingUp(horizon, `Needs ${cfg.minCurrent}+ days of recent data and ${cfg.minBaseline}+ earlier days; have ${current.length} and ${baseline.length}.`);
  }
  const view = viewOf(current, baseline, { nDays: baseline.length });
  const label = labelFor(view, view.raw.current);
  const coverage = horizon === 'medium' ? baseline.length / cfg.baselineDays : baseline.length / 365;
  const window = horizon === 'medium' ? 'a typical day this past week' : 'a typical day over the last four weeks';
  const baselineText = horizon === 'medium' ? `${baseline.length} days over the previous 12 weeks` : `${baseline.length} days of earlier history`;
  return {
    horizon, status: 'ok', label, confidence: confidenceOf(coverage), coverage: Math.min(1, coverage), ...view,
    explanation: describe({ horizon, window, baselineText, view, label, latest: { ...latest, ticker }, rankText: horizon === 'medium' && profile.rankInfo ? rankText(latest) : '', noun: profile.noun }),
  };
}

// Score one stock on all three horizons. `series` need not be prepared; it must be sorted by time.
function scoreStock(rawSeries, { ticker, source = 'reddit' } = {}) {
  const profile = PROFILES[source] || PROFILES.reddit;
  if (!rawSeries.length) {
    const none = (h) => warmingUp(h, 'No data collected yet.', { label: 'No data' });
    return { version: CONFIG.version, short: none('short'), medium: none('medium'), long: none('long'), summary: { label: 'No data', horizon: null } };
  }
  const series = prepare(rawSeries);
  const short = scoreShort(series, ticker, profile);
  const medium = scoreDaily(series, ticker, 'medium', profile);
  const long = scoreDaily(series, ticker, 'long', profile);
  const rated = [short, medium, long].filter((h) => h.status === 'ok');
  const top = rated.reduce((best, h) => (!best || rank(h.label) > rank(best.label) ? h : best), null);
  return {
    version: CONFIG.version,
    short, medium, long,
    summary: top ? { label: top.label, horizon: top.horizon, explanation: top.explanation } : { label: 'Warming up', horizon: null },
  };
}

// Rates day `i` of a DAILY series (values[k] = the value on calendar day k, null when missing) exactly as the live
// short horizon does for daily data (Wikipedia page views): same-weekday baseline once 4+ weeks exist, otherwise the
// previous 7 days; spread from up to 28 daily observations. Used by the backtests so they cannot drift from the live logic.
function rateDaily(values, i) {
  const cur = values[i];
  if (cur === null || cur === undefined) return null;
  const lagValues = [];
  for (let k = 1; k <= CONFIG.short.weeklyLags; k++) {
    const v = values[i - 7 * k];
    if (v !== null && v !== undefined) lagValues.push(v);
  }
  let base;
  let nDays;
  if (lagValues.length >= CONFIG.short.minWeeklyLags) {
    base = lagValues;
    nDays = lagValues.length;
  } else {
    base = [];
    let oldest = null;
    for (let k = 7; k >= 1; k--) {
      const v = values[i - k];
      if (v !== null && v !== undefined) {
        base.push(v);
        if (oldest === null) oldest = k;
      }
    }
    if (!base.length || oldest < CONFIG.short.minSpanDays + 1) return null; // warming up
    nDays = Math.max(1, Math.min(7, Math.round(oldest)));
  }
  const spread = [];
  for (let k = 1; k <= CONFIG.spreadDays; k++) {
    const v = values[i - k];
    if (v !== null && v !== undefined) spread.push(v);
  }
  const m = compare(cur, base, { floor: 1, spread, countBase: median(base), nDays });
  const hit = cur >= CONFIG.minLevel ? CONFIG.thresholds.find((t) => m.ratio >= t.ratio && m.z >= t.z) : null;
  const label = hit ? hit.label : median(base) < CONFIG.lowVolume && cur < CONFIG.minLevel ? 'Low volume' : 'Quiet';
  return { label, ratio: m.ratio, z: m.z };
}

module.exports = { scoreStock, rateDaily, CONFIG, PROFILES, prepare, compare, DAY, HOUR };
