// Integrity audit: re-derives what should be in the database from the raw API responses RAVE kept, and compares.
// It answers "was every collection run saved correctly?" with evidence rather than trust.
const EXPECTED_GAP_MIN = 45; // the collector runs about every 30-35 minutes

const COUNT_CHECKS = `
  WITH runs AS (
    SELECT id, started_at, pages_fetched, tickers_seen, rows_written, market_total_mentions
    FROM collection_runs WHERE kind = 'apewisdom' AND status = 'success' ORDER BY started_at DESC LIMIT $1
  ), raw_rows AS (
    SELECT rs.run_id, rs.page, upper(trim(e->>'ticker')) AS ticker, (e->>'mentions')::int AS mentions, (e->>'rank')::int AS rank
    FROM raw_snapshots rs JOIN runs r ON r.id = rs.run_id, jsonb_array_elements(rs.payload->'results') e
  ), raw_sum AS (
    SELECT run_id, count(DISTINCT page) AS pages, count(DISTINCT ticker) AS tickers, sum(mentions) AS mentions FROM raw_rows GROUP BY run_id
  ), snap AS (
    SELECT run_id, count(*) AS n FROM snapshots WHERE run_id IN (SELECT id FROM runs) GROUP BY run_id
  ), bad AS (
    SELECT s.run_id, count(*) AS n
    FROM snapshots s LEFT JOIN raw_rows rr ON rr.run_id = s.run_id AND rr.ticker = s.ticker
    WHERE s.run_id IN (SELECT run_id FROM raw_sum) -- runs whose raw responses expired cannot be compared
      AND ((s.ranked AND (rr.ticker IS NULL OR rr.mentions <> s.mentions OR rr.rank <> s.rank))
        OR (NOT s.ranked AND (rr.ticker IS NOT NULL OR s.mentions <> 0)))
    GROUP BY s.run_id
  ), missing AS (
    SELECT r.id AS run_id, count(*) AS n
    FROM runs r CROSS JOIN watchlist w
    WHERE w.active AND NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.run_id = r.id AND s.ticker = w.ticker)
    GROUP BY r.id
  )
  SELECT r.id, r.started_at AS "startedAt", r.pages_fetched AS "pagesFetched", r.tickers_seen AS "tickersSeen",
         r.rows_written AS "rowsWritten", r.market_total_mentions AS "marketTotal",
         rs.pages AS "rawPages", rs.tickers AS "rawTickers", rs.mentions::int AS "rawMentions",
         coalesce(sn.n, 0)::int AS "snapshotRows", coalesce(b.n, 0)::int AS "mismatchedRows", coalesce(m.n, 0)::int AS "missingWatchlist"
  FROM runs r LEFT JOIN raw_sum rs ON rs.run_id = r.id LEFT JOIN snap sn ON sn.run_id = r.id
       LEFT JOIN bad b ON b.run_id = r.id LEFT JOIN missing m ON m.run_id = r.id
  ORDER BY r.started_at DESC`;

async function auditRuns(pool, { runs = 48 } = {}) {
  const { rows } = await pool.query(COUNT_CHECKS, [runs]);
  const withRaw = rows.filter((r) => r.rawPages !== null);
  const failures = (pick, text) => rows.filter(pick).map((r) => `run ${r.id}: ${text(r)}`);

  const checks = [
    {
      id: 'rows-saved', label: 'Every run saved the number of rows it reported',
      problems: failures((r) => r.snapshotRows !== r.rowsWritten, (r) => `${r.snapshotRows} rows stored, ${r.rowsWritten} reported`),
    },
    {
      id: 'watchlist-complete', label: 'Every watchlist stock has a row in every run',
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
      id: 'market-total', label: 'Leaderboard total mentions equals the sum in the raw responses',
      problems: failures((r) => r.rawPages !== null && r.rawMentions !== r.marketTotal, (r) => `raw sum ${r.rawMentions}, stored total ${r.marketTotal}`),
    },
    {
      id: 'values-match', label: 'Every stored mention count and rank equals the raw response',
      problems: failures((r) => r.mismatchedRows > 0, (r) => `${r.mismatchedRows} stored row(s) differ from the raw data`),
    },
  ].map(({ problems, ...c }) => ({ ...c, ok: problems.length === 0, problems }));

  // Cadence: gaps between consecutive successful runs (a gap is data that was never collected)
  const times = rows.map((r) => new Date(r.startedAt).getTime()).sort((a, b) => a - b);
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
    note: withRaw.length < rows.length
      ? `${rows.length - withRaw.length} older run(s) no longer have raw responses (kept for a limited time), so only the row counts were checked for them.`
      : null,
  };
}

module.exports = { auditRuns };
