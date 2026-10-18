// RAVE scoring: how unusual is a stock's Reddit attention right now, over short / medium / long horizons?
//
// ApeWisdom `mentions` is a rolling 24-hour count, so every point already covers a full day (no hour-of-day
// effect). A stock is compared with ITS OWN history. Two views are computed: raw mentions, and the stock's
// share of all leaderboard chatter, which removes market-wide waves. Labels use the share view when available.
// All thresholds live in CONFIG so a change is a new version, and backtests can use exactly what runs live.
const { median, scaledMad } = require('./stats');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const CONFIG = {
  version: 'v1',
  minLevel: 10, // mentions per 24h below which a stock is never flagged (tiny counts are noise)
  minScale: 0.05, // floor for the spread in log space (5%) so a flat history cannot make z explode
  thresholds: [
    { label: 'Extreme', ratio: 3, z: 4 },
    { label: 'Hot', ratio: 2, z: 3 },
    { label: 'Rising', ratio: 1.5, z: 2 },
  ],
  short: { baselineDays: 8, minSpanDays: 2, weeklyLags: 8, minWeeklyLags: 4, toleranceMs: 3 * HOUR, persistenceGapMs: 20 * 60 * 1000 },
  medium: { currentDays: 7, minCurrent: 5, baselineFromDay: 7, baselineDays: 84, minBaseline: 28, toleranceMs: 3 * HOUR },
  long: { currentDays: 28, minCurrent: 20, baselineFromDay: 28, baselineDays: 730, minBaseline: 28, toleranceMs: 3 * HOUR },
};

const rank = (label) => ['Quiet', 'Rising', 'Hot', 'Extreme'].indexOf(label);
const fmt = (n) => (n >= 100 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 10) / 10));
const x = (ratio) => `${fmt(ratio)}×`;

// series: points sorted by time: { t, mentions, market, ranked, rank, rank24hAgo, mentions24hAgo }
// `market` is the total mentions across the leaderboard at that time (null if unknown).
function prepare(series) {
  return series.map((p) => ({ ...p, share: p.market > 0 ? (1000 * p.mentions) / p.market : null }));
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

// Compare a current value with baseline values: ratio to the baseline median, and a robust z-score on the log scale
function compare(current, baseline, { floor }) {
  const base = median(baseline);
  const logs = baseline.map((v) => Math.log1p(v));
  const scale = Math.max(scaledMad(logs), CONFIG.minScale);
  return {
    current,
    baselineMedian: base,
    ratio: current / Math.max(base, floor),
    z: (Math.log1p(current) - median(logs)) / scale,
    n: baseline.length,
  };
}

function viewOf(currentPoints, baselinePoints) {
  const medianOf = (pts, f) => median(pts.map((p) => p[f]));
  const have = (pts, f) => pts.length && pts.every((p) => p[f] !== null && p[f] !== undefined);
  const raw = compare(medianOf(currentPoints, 'mentions'), baselinePoints.map((p) => p.mentions), { floor: 1 });
  const shareOk = have(currentPoints, 'share') && have(baselinePoints, 'share');
  const adjusted = shareOk
    ? compare(medianOf(currentPoints, 'share'), baselinePoints.map((p) => p.share), { floor: 0.01 })
    : null;
  const marketOk = have(currentPoints, 'market') && have(baselinePoints, 'market');
  const market = marketOk
    ? compare(medianOf(currentPoints, 'market'), baselinePoints.map((p) => p.market), { floor: 1 })
    : null;
  return { raw, adjusted, market };
}

function labelFor(view, level) {
  if (level < CONFIG.minLevel) return 'Quiet';
  const m = view.adjusted || view.raw;
  const hit = CONFIG.thresholds.find((t) => m.ratio >= t.ratio && m.z >= t.z);
  return hit ? hit.label : 'Quiet';
}

function confidenceOf(coverage) {
  return coverage >= 1 ? 'high' : coverage >= 0.5 ? 'medium' : 'low';
}

function describe({ horizon, window, baselineText, view, label, latest, rankText }) {
  const { raw, adjusted, market } = view;
  const parts = [
    `${latest.ticker ? `${latest.ticker}: ` : ''}${x(raw.ratio)} normal over ${window} (${fmt(raw.current)} mentions vs a typical ${fmt(raw.baselineMedian)}, based on ${baselineText}).`,
    `That is ${fmt(Math.abs(raw.z))} robust standard deviations ${raw.z >= 0 ? 'above' : 'below'} normal.`,
  ];
  if (adjusted && market) {
    parts.push(
      `Overall Reddit stock chatter is ${x(market.ratio)} normal, so adjusted for that it is ${x(adjusted.ratio)} normal (z ${fmt(adjusted.z)}).`
    );
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

function scoreShort(series, ticker) {
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

  const view = viewOf([latest], baseline);
  let label = labelFor(view, latest.mentions);
  const result = { horizon: 'short', status: 'ok', confidence: confidenceOf(coverage), coverage, ...view };

  // A single-snapshot glitch must not flag a stock: the previous snapshot has to agree at least at Rising level
  const prev = [...series].reverse().find((p) => p.t <= now - cfg.persistenceGapMs);
  if (rank(label) > 1 && prev) {
    const prevLabel = labelFor(viewOf([prev], baseline), prev.mentions);
    if (rank(prevLabel) < 1) {
      label = 'Rising';
      result.unconfirmed = true;
    }
  }
  result.label = label;
  result.explanation = describe({ horizon: 'short', window: 'the last 24 hours', baselineText, view, label, latest: { ...latest, ticker }, rankText: rankText(latest) }) +
    (result.unconfirmed ? ' Capped at Rising until the next snapshot confirms it.' : '');
  return result;
}

function scoreDaily(series, ticker, horizon) {
  const cfg = CONFIG[horizon];
  const latest = series[series.length - 1];
  const now = latest.t;
  const current = dailyPoints(series, now, 0, cfg.currentDays, cfg.toleranceMs);
  const baseline = dailyPoints(series, now, cfg.baselineFromDay, cfg.baselineFromDay + cfg.baselineDays, cfg.toleranceMs);
  if (current.length < cfg.minCurrent || baseline.length < cfg.minBaseline) {
    return warmingUp(horizon, `Needs ${cfg.minCurrent}+ days of recent data and ${cfg.minBaseline}+ earlier days; have ${current.length} and ${baseline.length}.`);
  }
  const view = viewOf(current, baseline);
  const label = labelFor(view, view.raw.current);
  const coverage = horizon === 'medium' ? baseline.length / cfg.baselineDays : baseline.length / 365;
  const window = horizon === 'medium' ? 'a typical day this past week' : 'a typical day over the last four weeks';
  const baselineText = horizon === 'medium' ? `${baseline.length} days over the previous 12 weeks` : `${baseline.length} days of earlier history`;
  return {
    horizon, status: 'ok', label, confidence: confidenceOf(coverage), coverage: Math.min(1, coverage), ...view,
    explanation: describe({ horizon, window, baselineText, view, label, latest: { ...latest, ticker }, rankText: horizon === 'medium' ? rankText(latest) : '' }),
  };
}

// Score one stock on all three horizons. `series` need not be prepared; it must be sorted by time.
function scoreStock(rawSeries, { ticker } = {}) {
  if (!rawSeries.length) {
    const none = (h) => warmingUp(h, 'No data collected yet.', { label: 'No data' });
    return { version: CONFIG.version, short: none('short'), medium: none('medium'), long: none('long'), summary: { label: 'No data', horizon: null } };
  }
  const series = prepare(rawSeries);
  const short = scoreShort(series, ticker);
  const medium = scoreDaily(series, ticker, 'medium');
  const long = scoreDaily(series, ticker, 'long');
  const rated = [short, medium, long].filter((h) => h.status === 'ok');
  const top = rated.reduce((best, h) => (!best || rank(h.label) > rank(best.label) ? h : best), null);
  return {
    version: CONFIG.version,
    short, medium, long,
    summary: top ? { label: top.label, horizon: top.horizon, explanation: top.explanation } : { label: 'Warming up', horizon: null },
  };
}

module.exports = { scoreStock, CONFIG, prepare, DAY, HOUR };
