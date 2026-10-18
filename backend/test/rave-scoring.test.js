const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreStock, CONFIG } = require('../src/rave/scoring');
const { median, scaledMad } = require('../src/rave/stats');
const { simulate, simulateCounts, START, DAY, HOUR } = require('./rave-sim');

const flagged = (label) => label === 'Hot' || label === 'Extreme';
const boost = (from, to, factor) => (t) => (t >= from && t < to ? factor : 1);

test('median and scaled MAD', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(median([])));
  assert.ok(Math.abs(scaledMad([1, 2, 3, 4, 5]) - 1.4826) < 1e-9);
});

test('no data, and too little history, are reported honestly rather than scored', () => {
  assert.equal(scoreStock([]).summary.label, 'No data');
  const day = simulate({ days: 2.5, seed: 3 });
  const s = scoreStock(day, { ticker: 'GME' });
  assert.equal(s.short.status, 'warming_up');
  assert.equal(s.short.label, 'Warming up');
  assert.match(s.short.explanation, /days? of history/);
  assert.equal(s.medium.status, 'warming_up');
  assert.equal(s.summary.label, 'Warming up');
});

test('with about 10 days only the short horizon is rated, with low-to-medium confidence', () => {
  const s = scoreStock(simulate({ days: 11, seed: 4 }), { ticker: 'GME' });
  assert.equal(s.short.status, 'ok');
  assert.notEqual(s.short.confidence, 'high');
  assert.equal(s.medium.status, 'warming_up');
  assert.equal(s.long.status, 'warming_up');
});

test('a quiet stock is rated Quiet and the explanation carries the numbers', () => {
  const s = scoreStock(simulate({ days: 40, seed: 5 }), { ticker: 'GME' });
  assert.equal(s.short.status, 'ok');
  assert.equal(s.short.label, 'Quiet');
  assert.match(s.short.explanation, /^GME: [\d.,]+× normal over the last 24 hours/);
  assert.match(s.short.explanation, /robust standard deviations/);
  assert.match(s.short.explanation, /Label: Quiet\./);
  assert.match(s.short.explanation, /Rank #5 \(was #6 a day ago\)/);
});

test('detects a sustained 3x surge at least 90% of the time (short horizon)', () => {
  let hits = 0;
  const trials = 100;
  for (let seed = 1; seed <= trials; seed++) {
    const end = START + 45 * DAY;
    const series = simulate({ days: 45, seed: 1000 + seed, multiplier: boost(end - 36 * HOUR, end + DAY, 3) });
    if (flagged(scoreStock(series).short.label)) hits++;
  }
  assert.ok(hits >= 90, `detected ${hits}/${trials}`);
});

test('a sustained 2x surge is at least Rising 90% of the time', () => {
  let hits = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const end = START + 45 * DAY;
    const series = simulate({ days: 45, seed: 2000 + seed, multiplier: boost(end - 36 * HOUR, end + DAY, 2) });
    if (scoreStock(series).short.label !== 'Quiet') hits++;
  }
  assert.ok(hits >= 90, `at least Rising in ${hits}/100`);
});

test('pure noise produces at most about one Hot-or-above episode per stock per quarter', () => {
  const seeds = 8;
  let episodes = 0;
  let evaluated = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const series = simulate({ days: 125, seed: 3000 + seed });
    let inEpisode = false;
    for (let i = 36 * 48; i < series.length; i += 12) {
      // every 6 hours from day 36 (so there are 4+ weeks of history) to the end: about 89 days
      const on = flagged(scoreStock(series.slice(0, i + 1)).short.label);
      if (on && !inEpisode) episodes++;
      inEpisode = on;
      evaluated++;
    }
  }
  const quarters = evaluated / (4 * 90) / 1; // 4 evaluations per day -> stock-quarters evaluated
  assert.ok(episodes <= Math.ceil(quarters), `${episodes} false episodes over ${quarters.toFixed(1)} stock-quarters`);
});

test('a market-wide wave that lifts every stock does not flag, but the raw view still shows it', () => {
  let quiet = 0;
  const trials = 50;
  let rawRatio = 0;
  for (let seed = 1; seed <= trials; seed++) {
    const end = START + 45 * DAY;
    const wave = boost(end - 36 * HOUR, end + DAY, 2);
    const s = scoreStock(simulate({ days: 45, seed: 4000 + seed, multiplier: wave, marketMultiplier: wave }));
    if (s.short.label === 'Quiet') quiet++;
    rawRatio += s.short.raw.ratio;
  }
  assert.ok(quiet >= 47, `Quiet in ${quiet}/${trials}`);
  assert.ok(rawRatio / trials > 1.7, 'raw mentions did double');
});

test('a single-snapshot glitch is capped at Rising until the next snapshot confirms it', () => {
  const series = simulate({ days: 20, seed: 6 });
  const last = series[series.length - 1];
  const glitch = [...series.slice(0, -1), { ...last, mentions: last.mentions * 5, market: last.market + last.mentions * 4 }];
  const s = scoreStock(glitch);
  assert.equal(s.short.label, 'Rising');
  assert.equal(s.short.unconfirmed, true);
  assert.match(s.short.explanation, /Capped at Rising/);
});

test('the minimum-activity rule: under 10 mentions never flags; 12 does', () => {
  const steady = (days, level, last) => {
    const pts = Array.from({ length: days * 48 }, (_, i) => ({
      t: START + i * (HOUR / 2), mentions: level + (i % 3 === 0 ? 1 : 0), market: 5000, ranked: true, rank: 90, rank24hAgo: 90, mentions24hAgo: level,
    }));
    return [...pts.slice(0, -2), { ...pts[pts.length - 2], mentions: last }, { ...pts[pts.length - 1], mentions: last }];
  };
  assert.equal(CONFIG.minLevel, 10);
  // a typical 2 a day jumping to 8: below the minimum activity, and too thin to rate, so "Low volume", never flagged
  assert.equal(scoreStock(steady(30, 2, 8)).short.label, 'Low volume');
  // a typical 6 a day (enough to rate) reaching 8: not flagged, simply Quiet
  assert.equal(scoreStock(steady(30, 6, 8)).short.label, 'Quiet');
  // from a typical 2 a day, 12 is clearly unusual (Rising) and 30 is a very large jump (Hot or above); the call is
  // deliberately conservative at tiny counts, where chance alone moves the numbers a lot
  assert.equal(scoreStock(steady(30, 2, 12)).short.label, 'Rising');
  assert.ok(flagged(scoreStock(steady(30, 2, 30)).short.label));
});

test('stocks that rarely get mentioned are labelled Low volume, with an explanation, not Quiet', () => {
  const s = scoreStock(simulateCounts({ days: 40, level: 1, seed: 31 }), { ticker: 'RIVN' });
  assert.equal(s.short.label, 'Low volume');
  assert.match(s.short.explanation, /fewer than 5 mentions a day/);
  assert.equal(s.summary.label, 'Low volume');
});

// Realistic volumes: counts are small (the live leaderboard averages about 2 mentions per ticker), so these
// regimes matter more than the 100-a-day simulator above.
function regime({ level, trials, seeds }) {
  const end = START + 45 * DAY;
  let rise3 = 0, hot3 = 0;
  for (let t = 1; t <= trials; t++) {
    const l = scoreStock(simulateCounts({ days: 45, level, seed: 7000 + t, multiplier: boost(end - 36 * HOUR, end + DAY, 3) })).short.label;
    if (l !== 'Quiet' && l !== 'Low volume') rise3++;
    if (flagged(l)) hot3++;
  }
  let hotEpisodes = 0, evals = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const series = simulateCounts({ days: 125, level, seed: 5000 + seed });
    let on = false;
    for (let i = 36 * 48; i < series.length; i += 12) {
      const now = flagged(scoreStock(series.slice(0, i + 1)).short.label);
      if (now && !on) hotEpisodes++;
      on = now;
      evals++;
    }
  }
  return { rise3: rise3 / trials, hot3: hot3 / trials, falseHotPerQuarter: hotEpisodes / (evals / (4 * 90)) };
}

test('at 45 mentions a day (e.g. NVDA today): surges are caught and false Hot flags are rare', () => {
  const r = regime({ level: 45, trials: 40, seeds: 3 });
  assert.ok(r.hot3 >= 0.9, `3x -> Hot+ ${r.hot3}`);
  assert.ok(r.falseHotPerQuarter <= 1, `false Hot+ per quarter ${r.falseHotPerQuarter}`);
});

test('at 17 mentions a day (e.g. GME today): a 3x surge is at least Rising 90% of the time, false Hot flags are rare', () => {
  const r = regime({ level: 17, trials: 40, seeds: 3 });
  assert.ok(r.rise3 >= 0.9, `3x -> Rising+ ${r.rise3}`);
  assert.ok(r.falseHotPerQuarter <= 1, `false Hot+ per quarter ${r.falseHotPerQuarter}`);
});

test('at 4 mentions a day: never a false Hot flag (detection is weak by nature, and the label says Low volume)', () => {
  const r = regime({ level: 4, trials: 20, seeds: 3 });
  assert.ok(r.falseHotPerQuarter <= 1, `false Hot+ per quarter ${r.falseHotPerQuarter}`);
});

test('a stock that drops off the leaderboard is Quiet and says so', () => {
  const series = simulate({ days: 20, seed: 8 });
  const last = series[series.length - 1];
  const gone = [...series.slice(0, -1), { ...last, mentions: 0, ranked: false, rank: null, rank24hAgo: 4 }];
  const s = scoreStock(gone, { ticker: 'AMC' });
  assert.equal(s.short.label, 'Quiet');
  assert.match(s.short.explanation, /Not on the leaderboard/);
});

test('medium and long horizons detect a sustained week-long and month-long surge', () => {
  const days = 110;
  const end = START + days * DAY;
  const week = scoreStock(simulate({ days, seed: 9, multiplier: boost(end - 8 * DAY, end + DAY, 3) }));
  assert.equal(week.medium.status, 'ok');
  assert.ok(flagged(week.medium.label), `medium ${week.medium.label}`);
  const month = scoreStock(simulate({ days, seed: 10, multiplier: boost(end - 30 * DAY, end + DAY, 3) }));
  assert.equal(month.long.status, 'ok');
  assert.ok(flagged(month.long.label), `long ${month.long.label}`);
  assert.ok(flagged(month.summary.label));
});

test('a one-day spike does not move the medium horizon (it is a typical-day measure)', () => {
  const days = 110;
  const end = START + days * DAY;
  const s = scoreStock(simulate({ days, seed: 11, multiplier: boost(end - 30 * HOUR, end + DAY, 4) }));
  assert.ok(flagged(s.short.label));
  assert.equal(s.medium.label, 'Quiet');
});

test('works when market totals are unavailable (raw view only)', () => {
  const series = simulate({ days: 40, seed: 12 }).map((p) => ({ ...p, market: null }));
  const s = scoreStock(series);
  assert.equal(s.short.adjusted, null);
  assert.equal(s.short.status, 'ok');
  assert.doesNotMatch(s.short.explanation, /Overall Reddit stock chatter/);
});

test('config is versioned and thresholds are ordered strictest first', () => {
  assert.equal(CONFIG.version, 'v1');
  assert.deepEqual(CONFIG.thresholds.map((t) => t.label), ['Extreme', 'Hot', 'Rising']);
  assert.equal(scoreStock(simulate({ days: 40, seed: 13 })).version, 'v1');
});
