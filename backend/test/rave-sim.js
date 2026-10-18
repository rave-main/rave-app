// Synthetic ApeWisdom-like data for testing the scoring: hourly counts with a weekday pattern and persistent
// day-to-day noise, reported the way ApeWisdom does (a rolling 24-hour count, sampled every 30 minutes).
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 0, 5); // a Monday

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

// multiplier(tMs) scales the stock's intensity, marketMultiplier(tMs) scales everyone else's
function simulate({ days, level = 100, others = 4000, seed = 1, dayNoise = 0.25, multiplier = () => 1, marketMultiplier = () => 1 }) {
  const r = rng(seed);
  const noise = Array.from({ length: days + 2 }, () => Math.exp(dayNoise * gauss(r)));
  const half = (t, base, mult) => {
    const d = Math.floor((t - START) / DAY);
    const weekday = (new Date(t).getUTCDay() + 6) % 7; // 0 = Monday
    const lambda = ((base / 48) * (weekday >= 5 ? 0.7 : 1) * noise[d] * mult(t));
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(r)));
  };
  const stock = [];
  const rest = [];
  const series = [];
  for (let i = 0; i < days * 48; i++) {
    const t = START + i * (HOUR / 2);
    stock.push(half(t, level, multiplier));
    rest.push(half(t, others, marketMultiplier));
    if (i >= 47) {
      const sum = (arr) => arr.slice(i - 47, i + 1).reduce((a, b) => a + b, 0);
      const mentions = sum(stock);
      series.push({ t, mentions, market: mentions + sum(rest), ranked: true, rank: 5, rank24hAgo: 6, mentions24hAgo: null });
    }
  }
  return series;
}

// Poisson sampler: exact for small means (Knuth), normal approximation for large ones
function poisson(r, lambda) {
  if (lambda <= 0) return 0;
  if (lambda >= 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(r)));
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r();
  } while (p > limit);
  return k - 1;
}

// Realistic LOW-VOLUME data. ApeWisdom's raw data is mention counts per 10 minutes; the API reports their rolling
// 24-hour sum (verified against the live site), sampled here every 30 minutes. `level` is mentions per day.
// Day-to-day interest varies persistently (dayNoise) on top of the Poisson noise, and weekends are quieter.
function simulateCounts({ days, level = 20, others = 1500, seed = 1, dayNoise = 0.3, multiplier = () => 1, marketMultiplier = () => 1 }) {
  const r = rng(seed);
  const noise = Array.from({ length: days + 2 }, () => Math.exp(dayNoise * gauss(r)));
  const bucket = (t, base, mult) => {
    const d = Math.floor((t - START) / DAY);
    const weekday = (new Date(t).getUTCDay() + 6) % 7;
    return poisson(r, (base / 144) * (weekday >= 5 ? 0.7 : 1) * noise[d] * mult(t));
  };
  const stock = [];
  const rest = [];
  const rolling = [];
  const series = [];
  for (let i = 0; i < days * 144; i++) {
    const t = START + i * (HOUR / 6);
    stock.push(bucket(t, level, multiplier));
    rest.push(bucket(t, others, marketMultiplier));
    if (i >= 143 && (i - 143) % 3 === 0) {
      const sum = (arr) => arr.slice(i - 143, i + 1).reduce((a, b) => a + b, 0);
      const mentions = sum(stock);
      rolling.push(mentions);
      series.push({ t, mentions, market: mentions + sum(rest), ranked: mentions > 0, rank: mentions > 0 ? 10 : null, rank24hAgo: null, mentions24hAgo: rolling[rolling.length - 49] ?? null });
    }
  }
  return series;
}

module.exports = { simulate, simulateCounts, poisson, rng, START, DAY, HOUR };
