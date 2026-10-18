// The "tracked" set and its scores. ALL leaderboard tickers are stored; the ones worth scoring are the watchlist
// plus any ticker that reached TRACK_MIN_PEAK mentions in the last 7 days (the rest are Low volume by definition).
const { loadSeries } = require('./series');
const { scoreStock } = require('./scoring');
const { loadWikiSeries } = require('./wiki');

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
    `SELECT coalesce(max(id)::text, '0') || '|' || coalesce(max(started_at)::text, '') || '|' ||
            (SELECT coalesce(max(id), 0) FROM collection_runs WHERE kind = 'wikipedia' AND status = 'success') AS run
     FROM collection_runs WHERE kind = 'apewisdom' AND status = 'success'`
  );
  if (cache.key === run && cache.value) return cache.value;
  const { rows } = await pool.query(TRACKED_SQL, [TRACK_MIN_PEAK]);
  const tickers = rows.map((r) => r.ticker);
  const series = await loadSeries(pool, tickers);
  const { rows: mapped } = await pool.query('SELECT ticker, article, status, confidence, source FROM wiki_pages WHERE ticker = ANY($1)', [tickers]);
  const wikiOf = new Map(mapped.map((m) => [m.ticker, m]));
  const wseries = await loadWikiSeries(pool, [...new Set(mapped.filter((m) => m.article).map((m) => m.article))]);
  const AT_LEAST_RISING = ['Rising', 'Hot', 'Extreme'];
  const value = rows.map((r) => {
    const scores = scoreStock(series.get(r.ticker), { ticker: r.ticker });
    const m = wikiOf.get(r.ticker);
    const wikiScores = m?.article ? scoreStock(wseries.get(m.article) || [], { ticker: r.ticker, source: 'wiki' }) : null;
    const redditUp = AT_LEAST_RISING.includes(scores.short.label);
    const wikiUp = Boolean(wikiScores) && AT_LEAST_RISING.includes(wikiScores.short.label);
    return {
      ...r,
      dayOverDay: dayOverDay(r),
      spark: series.get(r.ticker).slice(-48).map((p) => p.mentions), // about the last 24 hours
      scores,
      wiki: m ? { article: m.article, status: m.status, confidence: m.confidence, source: m.source, scores: wikiScores } : { article: null, status: 'pending', confidence: 'none', source: 'auto', scores: null },
      // both signals agree when Reddit and Wikipedia are each at Rising or above (short horizon)
      agreement: redditUp && wikiUp ? 'both' : redditUp ? 'reddit' : wikiUp ? 'wiki' : 'none',
    };
  });
  cache = { key: run, value };
  return value;
}

module.exports = { scoredStocks, dayOverDay, TRACK_MIN_PEAK, TRACKED_SQL };
