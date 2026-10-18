// Integrity audit: re-derives what should be in the database from the raw API responses RAVE kept, and compares.
// It answers "was every collection run saved correctly?" with evidence rather than trust.
const EXPECTED_GAP_MIN = 45; // the collector runs every 30 minutes

// Per run: where it was stored (day + slot), and whether a later run in the same slot overwrote it
const AUDIT_SQL = `
  WITH runs AS (
    SELECT c.id, c.started_at, (c.details->>'legacy') = 'true' AS legacy, c.pages_fetched, c.tickers_seen, c.rows_written, c.market_total_mentions,
           (c.started_at AT TIME ZONE 'UTC')::date AS day,
           floor((extract(hour FROM c.started_at AT TIME ZONE 'UTC') * 60 + extract(minute FROM c.started_at AT TIME ZONE 'UTC')) / 30)::int AS slot
    FROM collection_runs c WHERE c.kind = 'apewisdom' AND c.status = 'success' ORDER BY c.started_at DESC LIMIT $1
  ), live AS (  -- the run whose values are actually stored in each slot (the latest one)
    SELECT r.* FROM runs r WHERE NOT EXISTS (
      SELECT 1 FROM collection_runs c2 WHERE c2.kind = 'apewisdom' AND c2.status = 'success' AND c2.started_at > r.started_at
        AND (c2.started_at AT TIME ZONE 'UTC')::date = r.day
        AND floor((extract(hour FROM c2.started_at AT TIME ZONE 'UTC') * 60 + extract(minute FROM c2.started_at AT TIME ZONE 'UTC')) / 30)::int = r.slot)
  ), raw_rows AS (
    SELECT rs.run_id, rs.page, upper(trim(e->>'ticker')) AS ticker, (e->>'mentions')::int AS mentions, (e->>'rank')::int AS rank
    FROM raw_snapshots rs JOIN runs r ON r.id = rs.run_id, jsonb_array_elements(rs.payload->'results') e
  ), raw_sum AS (
    SELECT run_id, count(DISTINCT page) AS pages, count(DISTINCT ticker) AS tickers, sum(mentions) AS mentions FROM raw_rows GROUP BY run_id
  ), stored AS (  -- every stored value at the run's slot
    SELECT l.id AS run_id, td.ticker, td.mentions[l.slot + 1] AS mentions, td.ranks[l.slot + 1] AS rank
    FROM live l JOIN ticker_days td ON td.day = l.day
  ), stored_n AS (
    SELECT run_id, count(*) FILTER (WHERE rank IS NOT NULL)::int AS listed FROM stored GROUP BY run_id
  ), mkt AS (
    SELECT l.id AS run_id, md.market[l.slot + 1] AS market, md.tickers[l.slot + 1] AS tickers FROM live l LEFT JOIN market_days md ON md.day = l.day
  ), bad AS (
    SELECT l.id AS run_id, count(*)::int AS n
    FROM live l
    JOIN raw_sum rs ON rs.run_id = l.id
    CROSS JOIN LATERAL (
      SELECT 1 FROM raw_rows rr LEFT JOIN stored s ON s.run_id = rr.run_id AND s.ticker = rr.ticker
       WHERE rr.run_id = l.id AND (s.ticker IS NULL OR s.mentions IS DISTINCT FROM rr.mentions OR s.rank IS DISTINCT FROM rr.rank)
      UNION ALL
      SELECT 1 FROM stored s LEFT JOIN raw_rows rr ON rr.run_id = s.run_id AND rr.ticker = s.ticker
       WHERE s.run_id = l.id AND s.rank IS NOT NULL AND rr.ticker IS NULL
    ) x
    GROUP BY l.id
  ), missing AS (
    SELECT l.id AS run_id, count(*)::int AS n
    FROM live l CROSS JOIN watchlist w
    WHERE w.active AND NOT EXISTS (SELECT 1 FROM ticker_days td WHERE td.day = l.day AND td.ticker = w.ticker AND td.mentions[l.slot + 1] IS NOT NULL)
    GROUP BY l.id
  )
  SELECT r.id, r.started_at AS "startedAt", r.slot, r.legacy, (l.id IS NOT NULL) AS "isLive", r.pages_fetched AS "pagesFetched", r.tickers_seen AS "tickersSeen",
         r.market_total_mentions AS "marketTotal",
         rs.pages AS "rawPages", rs.tickers AS "rawTickers", rs.mentions::int AS "rawMentions",
         sn.listed AS "storedListed", mk.market AS "storedMarket", coalesce(b.n, 0) AS "mismatchedRows", coalesce(m.n, 0) AS "missingWatchlist"
  FROM runs r LEFT JOIN live l ON l.id = r.id LEFT JOIN raw_sum rs ON rs.run_id = r.id LEFT JOIN stored_n sn ON sn.run_id = r.id
       LEFT JOIN mkt mk ON mk.run_id = r.id LEFT JOIN bad b ON b.run_id = r.id LEFT JOIN missing m ON m.run_id = r.id
  ORDER BY r.started_at DESC`;

async function auditRuns(pool, { runs = 48 } = {}) {
  const { rows: all } = await pool.query(AUDIT_SQL, [runs]);
  // A run overwritten by a later one in the same half hour is superseded, not an error. Runs from before the storage
  // migration kept only the watchlist and the top 100 in the old layout, so they cannot be re-derived in full.
  const legacy = all.filter((r) => r.legacy).length;
  const rows = all.filter((r) => r.isLive && !r.legacy);
  const withRaw = rows.filter((r) => r.rawPages !== null);
  const failures = (pick, text) => rows.filter(pick).map((r) => `run ${r.id}: ${text(r)}`);

  const checks = [
    {
      id: 'rows-saved', label: 'Every run stored every ticker it reported',
      problems: failures((r) => r.storedListed !== r.tickersSeen, (r) => `${r.storedListed} tickers stored, ${r.tickersSeen} reported`),
    },
    {
      id: 'watchlist-complete', label: 'Every watchlist stock has a reading in every run',
      problems: failures((r) => r.missingWatchlist > 0, (r) => `${r.missingWatchlist} watchlist stock(s) missing`),
    },
    {
      id: 'raw-pages', label: 'Raw responses cover every page fetched',
      problems: failures((r) => r.rawPages !== null && Number(r.rawPages) !== r.pagesFetched, (r) => `${r.rawPages} raw pages, ${r.pagesFetched} fetched`),
    },
    {
      id: 'raw-tickers', label: 'Raw responses contain the number of tickers the run reported',
      problems: failures((r) => r.rawPages !== null && Number(r.rawTickers) !== r.tickersSeen, (r) => `${r.rawTickers} in raw data, ${r.tickersSeen} reported`),
    },
    {
      id: 'market-total', label: 'Leaderboard total mentions equals the sum in the raw responses and the stored total',
      problems: failures((r) => (r.rawPages !== null && r.rawMentions !== r.marketTotal) || r.storedMarket !== r.marketTotal,
        (r) => `raw sum ${r.rawMentions}, run total ${r.marketTotal}, stored ${r.storedMarket}`),
    },
    {
      id: 'values-match', label: 'Every stored mention count and rank equals the raw response',
      problems: failures((r) => r.mismatchedRows > 0, (r) => `${r.mismatchedRows} stored value(s) differ from the raw data`),
    },
  ].map(({ problems, ...c }) => ({ ...c, ok: problems.length === 0, problems }));

  // Cadence: gaps between consecutive successful runs (a gap is data that was never collected)
  const times = all.map((r) => new Date(r.startedAt).getTime()).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const min = (times[i] - times[i - 1]) / 60000;
    if (min > EXPECTED_GAP_MIN) gaps.push({ from: new Date(times[i - 1]).toISOString(), to: new Date(times[i]).toISOString(), minutes: Math.round(min) });
  }

  return {
    runsChecked: rows.length,
    runsWithRawData: withRaw.length,
    ok: checks.every((c) => c.ok),
    checks,
    cadence: { expectedMinutes: 30, gapsOver45Min: gaps.length, longestGapMinutes: gaps.length ? Math.max(...gaps.map((g) => g.minutes)) : null, gaps: gaps.slice(-10) },
    note: [
      legacy ? `${legacy} early run(s) were stored in the earlier layout (watchlist and top 100 only) and are not re-checked.` : null,
      withRaw.length < rows.length ? `${rows.length - withRaw.length} older run(s) no longer have raw responses (kept for 7 days), so only the stored totals were checked for them.` : null,
    ].filter(Boolean).join(' ') || null,
  };
}

module.exports = { auditRuns };
