// Loads each ticker's attention history as scoring-ready series: the last 9 days at full resolution
// (about every 30 minutes) and anything older downsampled to one point per hour, which is all the
// medium and long horizons need.
async function loadSeries(pool, tickers, now = new Date()) {
  const { rows } = await pool.query(
    `WITH recent AS (
       SELECT s.ticker, s.fetched_at, s.mentions, s.ranked, s.rank, s.rank_24h_ago, s.mentions_24h_ago, r.market_total_mentions AS market
       FROM snapshots s JOIN collection_runs r ON r.id = s.run_id
       WHERE s.ticker = ANY($1) AND s.fetched_at > $2::timestamptz - interval '9 days'
     ), older AS (
       SELECT DISTINCT ON (s.ticker, date_trunc('hour', s.fetched_at))
              s.ticker, s.fetched_at, s.mentions, s.ranked, s.rank, s.rank_24h_ago, s.mentions_24h_ago, r.market_total_mentions AS market
       FROM snapshots s JOIN collection_runs r ON r.id = s.run_id
       WHERE s.ticker = ANY($1) AND s.fetched_at <= $2::timestamptz - interval '9 days'
       ORDER BY s.ticker, date_trunc('hour', s.fetched_at), s.fetched_at DESC
     )
     SELECT * FROM older UNION ALL SELECT * FROM recent ORDER BY ticker, fetched_at`,
    [tickers, now]
  );
  const byTicker = new Map(tickers.map((t) => [t, []]));
  for (const r of rows) {
    byTicker.get(r.ticker).push({
      t: new Date(r.fetched_at).getTime(),
      mentions: r.mentions,
      market: r.market,
      ranked: r.ranked,
      rank: r.rank,
      rank24hAgo: r.rank_24h_ago,
      mentions24hAgo: r.mentions_24h_ago,
    });
  }
  return byTicker;
}

module.exports = { loadSeries };
