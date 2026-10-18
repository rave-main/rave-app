// Loads attention history as scoring-ready series from the compact day arrays (see store.js).
// Resolution by age keeps memory bounded: last 9 days at every slot (30 min), up to 40 days hourly, older every 6 hours
// (the medium/long horizons only need a point near the same time of day, within 3 hours).
const { SLOTS, DAY_MS, pointTime } = require('./store');

const keep = (daysAgo, slot) => daysAgo <= 9 || (daysAgo <= 40 && slot % 2 === 0) || slot % 12 === 0;

async function loadSeries(pool, tickers, { now = new Date(), days = 800 } = {}) {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const fromDay = new Date(today - days * DAY_MS).toISOString().slice(0, 10);
  const [{ rows: markets }, { rows: rowsByDay }, { rows: latest }] = await Promise.all([
    pool.query('SELECT day::text AS day, market FROM market_days WHERE day >= $1 ORDER BY day', [fromDay]),
    pool.query('SELECT ticker, day::text AS day, mentions, ranks FROM ticker_days WHERE ticker = ANY($1) AND day >= $2', [tickers, fromDay]),
    pool.query('SELECT ticker, rank_24h_ago AS "rank24hAgo", mentions_24h_ago AS "mentions24hAgo" FROM tickers WHERE ticker = ANY($1)', [tickers]),
  ]);
  const byKey = new Map(rowsByDay.map((r) => [`${r.ticker}|${r.day}`, r]));
  const out = new Map(tickers.map((t) => [t, []]));

  for (const ticker of tickers) {
    const points = out.get(ticker);
    for (const md of markets) {
      const daysAgo = Math.round((today - Date.parse(`${md.day}T00:00:00Z`)) / DAY_MS);
      const row = byKey.get(`${ticker}|${md.day}`);
      for (let slot = 0; slot < SLOTS; slot++) {
        const market = md.market[slot];
        if (market === null || market === undefined || !keep(daysAgo, slot)) continue;
        const mentions = row ? row.mentions[slot] : 0; // no row that day means the ticker was not on the leaderboard
        if (mentions === null || mentions === undefined) continue;
        const rank = row ? row.ranks[slot] : null;
        points.push({ t: pointTime(md.day, slot), mentions, market, ranked: rank !== null && rank !== undefined, rank: rank ?? null, rank24hAgo: null, mentions24hAgo: null });
      }
    }
  }
  // The source's own "24 hours ago" figures only exist for the latest reading
  for (const l of latest) {
    const pts = out.get(l.ticker);
    if (pts && pts.length) Object.assign(pts[pts.length - 1], { rank24hAgo: l.rank24hAgo, mentions24hAgo: l.mentions24hAgo });
  }
  return out;
}

module.exports = { loadSeries };
