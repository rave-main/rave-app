// The "tracked" set and its scores. ALL leaderboard tickers are stored; the ones worth scoring are the watchlist
// plus any ticker that reached TRACK_MIN_PEAK mentions in the last 7 days (the rest are Low volume by definition).
const { loadSeries } = require('./series');
const { scoreStock } = require('./scoring');

const TRACK_MIN_PEAK = 5;

const TRACKED_SQL = `
  SELECT t.ticker, coalesce(w.name, t.name, t.ticker) AS name,
         w.ticker IS NOT NULL AS "isWatchlist", coalesce(w.is_control, false) AS "isControl",
         t.fetched_at AS "fetchedAt", t.ranked, t.rank, t.mentions, t.upvotes,
         t.rank_24h_ago AS "rank24hAgo", t.mentions_24h_ago AS "mentions24hAgo"
  FROM tickers t LEFT JOIN watchlist w ON w.ticker = t.ticker AND w.active
  WHERE w.ticker IS NOT NULL
     OR t.ticker IN (SELECT ticker FROM ticker_days
                     WHERE day >= (now() AT TIME ZONE 'UTC')::date - 7 AND (SELECT max(m) FROM unnest(mentions) m) >= $1)
  ORDER BY (w.ticker IS NULL), w.is_control, t.mentions DESC, t.ticker`;

// ApeWisdom's own comparison with 24 hours earlier; available from the very first reading
function dayOverDay(r) {
  if (r.mentions24hAgo === null || r.mentions24hAgo === undefined) return null;
  return { change: r.mentions - r.mentions24hAgo, ratio: r.mentions24hAgo > 0 ? r.mentions / r.mentions24hAgo : null };
}

let cache = { key: null, value: null };

// Scores for every tracked stock, cached until the next collection run lands
async function scoredStocks(pool) {
  const { rows: [{ run }] } = await pool.query(
    `SELECT coalesce(max(id)::text, '0') || '|' || coalesce(max(started_at)::text, '') AS run FROM collection_runs WHERE kind = 'apewisdom' AND status = 'success'`
  );
  if (cache.key === run && cache.value) return cache.value;
  const { rows } = await pool.query(TRACKED_SQL, [TRACK_MIN_PEAK]);
  const series = await loadSeries(pool, rows.map((r) => r.ticker));
  const value = rows.map((r) => ({
    ...r,
    dayOverDay: dayOverDay(r),
    spark: series.get(r.ticker).slice(-48).map((p) => p.mentions), // about the last 24 hours
    scores: scoreStock(series.get(r.ticker), { ticker: r.ticker }),
  }));
  cache = { key: run, value };
  return value;
}

module.exports = { scoredStocks, dayOverDay, TRACK_MIN_PEAK, TRACKED_SQL };
