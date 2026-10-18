// Compact storage of the ApeWisdom leaderboard for EVERY ticker.
//
// One row per ticker per UTC day holds up to 48 half-hour readings in an array (`ticker_days`), instead of one
// row per reading: about 400 bytes per ticker-day, so all ~820 tickers cost about 120 MB a year (the earlier
// row-per-reading layout cost about 450 MB a year for only ~100 tickers).
//
// A reading is stored in the slot of the half hour it was taken in (slot 0 = 00:00-00:29 UTC). `market_days`
// records, per slot, the total mentions on the whole leaderboard and how many tickers it listed; a non-NULL
// market slot means "a collection ran in this slot", which is how NULL ("no reading") is told apart from a real 0.
// A ticker missing from the leaderboard has 0 mentions (the leaderboard lists everything with at least 1), so a
// ticker-day row is only created the day a ticker first appears, pre-filled with zeros for the earlier slots.
const SLOTS = 48;
const SLOT_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function slotOf(date) {
  const t = new Date(date).getTime();
  const dayStart = Math.floor(t / DAY_MS) * DAY_MS;
  return { day: new Date(dayStart).toISOString().slice(0, 10), slot: Math.floor((t - dayStart) / SLOT_MS), dayStart };
}

const pointTime = (day, slot) => Date.parse(`${day}T00:00:00Z`) + slot * SLOT_MS;

// Writes one collection run. `rows` are parsed leaderboard rows; `listed` is every ticker on the leaderboard.
async function storeRun(client, { startedAt, rows, marketTotal }) {
  const { day, slot } = slotOf(startedAt);
  const pos = slot + 1; // Postgres arrays are 1-based

  await client.query(
    `INSERT INTO market_days (day, market, tickers)
     VALUES ($1, array_fill(NULL::int, ARRAY[${SLOTS}]), array_fill(NULL::smallint, ARRAY[${SLOTS}])) ON CONFLICT DO NOTHING`,
    [day]
  );
  await client.query('UPDATE market_days SET market[$2] = $3, tickers[$2] = $4 WHERE day = $1', [day, pos, marketTotal, rows.length]);

  const listed = rows.map((r) => r.ticker);

  // New ticker-day rows start as 0 for every slot a collection already ran in today, NULL for the others
  await client.query(
    `INSERT INTO ticker_days (ticker, day, mentions, ranks)
     SELECT e.tk, md.day,
            (SELECT array_agg(CASE WHEN m IS NULL THEN NULL ELSE 0 END ORDER BY ord) FROM unnest(md.market) WITH ORDINALITY AS u(m, ord)),
            array_fill(NULL::smallint, ARRAY[${SLOTS}])
     FROM unnest($1::text[]) AS e(tk) CROSS JOIN market_days md WHERE md.day = $2
     ON CONFLICT DO NOTHING`,
    [listed, day]
  );
  await client.query(
    `UPDATE ticker_days td SET mentions[$3] = v.m, ranks[$3] = v.r
     FROM unnest($1::text[], $4::int[], $5::int[]) AS v(t, m, r)
     WHERE td.day = $2 AND td.ticker = v.t`,
    [listed, day, pos, rows.map((r) => r.mentions), rows.map((r) => r.rank)]
  );
  // Anything with a row today that is no longer listed has 0 mentions now
  await client.query(
    `UPDATE ticker_days SET mentions[$2] = 0, ranks[$2] = NULL WHERE day = $1 AND NOT (ticker = ANY($3::text[]))`,
    [day, pos, listed]
  );

  // Latest state per ticker (names live here; used for the ticker list, day-over-day and Wikipedia lookups)
  await client.query(
    `INSERT INTO tickers (ticker, name, first_seen, last_seen, fetched_at, ranked, rank, mentions, upvotes, rank_24h_ago, mentions_24h_ago)
     SELECT v.t, v.name, $1, $1, $1, true, v.r, v.m, v.u, v.r24, v.m24
     FROM unnest($2::text[], $3::text[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[]) AS v(t, name, r, m, u, r24, m24)
     ON CONFLICT (ticker) DO UPDATE SET name = coalesce(EXCLUDED.name, tickers.name), last_seen = EXCLUDED.last_seen,
       fetched_at = EXCLUDED.fetched_at, ranked = true, rank = EXCLUDED.rank, mentions = EXCLUDED.mentions, upvotes = EXCLUDED.upvotes,
       rank_24h_ago = EXCLUDED.rank_24h_ago, mentions_24h_ago = EXCLUDED.mentions_24h_ago`,
    [startedAt, listed, rows.map((r) => r.name), rows.map((r) => r.rank), rows.map((r) => r.mentions), rows.map((r) => r.upvotes),
      rows.map((r) => r.rank24hAgo), rows.map((r) => r.mentions24hAgo)]
  );
  await client.query(
    `UPDATE tickers SET ranked = false, rank = NULL, mentions = 0, fetched_at = $1, rank_24h_ago = NULL, mentions_24h_ago = NULL
     WHERE NOT (ticker = ANY($2::text[]))`,
    [startedAt, listed]
  );
  return { day, slot };
}

module.exports = { SLOTS, SLOT_MS, DAY_MS, slotOf, pointTime, storeRun };
