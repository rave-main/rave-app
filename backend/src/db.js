const { Pool } = require('pg');

// Each migration runs once, in order, inside a transaction. Append new ones; never edit old ones.
const migrations = [
  `CREATE TABLE users (
     id SERIAL PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE TABLE sessions (
     id SERIAL PRIMARY KEY,
     token_hash TEXT NOT NULL UNIQUE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX sessions_user_id_idx ON sessions(user_id);
   CREATE TABLE notes (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     body TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX notes_user_id_idx ON notes(user_id);`,

  // RAVE: watchlist, collection runs, and ApeWisdom snapshots
  `CREATE TABLE watchlist (
     ticker TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     is_control BOOLEAN NOT NULL DEFAULT false,
     active BOOLEAN NOT NULL DEFAULT true,
     added_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   INSERT INTO watchlist (ticker, name, is_control) VALUES
     ('GME', 'GameStop', false), ('AMC', 'AMC Entertainment', false), ('PLTR', 'Palantir', false),
     ('SOFI', 'SoFi Technologies', false), ('RIVN', 'Rivian', false), ('NVDA', 'NVIDIA', false),
     ('TSLA', 'Tesla', false), ('HOOD', 'Robinhood', false),
     ('AAPL', 'Apple', true), ('MSFT', 'Microsoft', true);
   CREATE TABLE collection_runs (
     id SERIAL PRIMARY KEY,
     kind TEXT NOT NULL,
     status TEXT NOT NULL,
     started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     finished_at TIMESTAMPTZ,
     pages_fetched INTEGER,
     pages_total INTEGER,
     tickers_seen INTEGER,
     rows_written INTEGER,
     market_total_mentions INTEGER,
     error TEXT
   );
   CREATE INDEX collection_runs_kind_started_idx ON collection_runs(kind, started_at DESC);
   CREATE TABLE raw_snapshots (
     id SERIAL PRIMARY KEY,
     run_id INTEGER NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
     source TEXT NOT NULL,
     filter TEXT NOT NULL,
     page INTEGER NOT NULL,
     fetched_at TIMESTAMPTZ NOT NULL,
     payload JSONB NOT NULL
   );
   CREATE INDEX raw_snapshots_fetched_at_idx ON raw_snapshots(fetched_at);
   CREATE TABLE snapshots (
     id BIGSERIAL PRIMARY KEY,
     run_id INTEGER NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
     source TEXT NOT NULL DEFAULT 'apewisdom',
     ticker TEXT NOT NULL,
     fetched_at TIMESTAMPTZ NOT NULL,
     ranked BOOLEAN NOT NULL,
     rank INTEGER,
     mentions INTEGER NOT NULL,
     upvotes INTEGER,
     rank_24h_ago INTEGER,
     mentions_24h_ago INTEGER,
     UNIQUE (source, ticker, fetched_at)
   );
   CREATE INDEX snapshots_ticker_time_idx ON snapshots(ticker, fetched_at DESC);`,

  // Compact storage for every ticker (see src/rave/store.js), replacing the row-per-reading `snapshots` table.
  // Existing data is converted: readings go to the slot of the half hour they were taken in.
  `CREATE TABLE tickers (
     ticker TEXT PRIMARY KEY,
     name TEXT,
     first_seen TIMESTAMPTZ NOT NULL,
     last_seen TIMESTAMPTZ NOT NULL,
     fetched_at TIMESTAMPTZ NOT NULL,
     ranked BOOLEAN NOT NULL,
     rank INTEGER,
     mentions INTEGER NOT NULL,
     upvotes INTEGER,
     rank_24h_ago INTEGER,
     mentions_24h_ago INTEGER
   ) WITH (fillfactor = 70);
   CREATE TABLE market_days (
     day DATE PRIMARY KEY,
     market INTEGER[] NOT NULL,
     tickers SMALLINT[] NOT NULL
   );
   CREATE TABLE ticker_days (
     ticker TEXT NOT NULL,
     day DATE NOT NULL,
     mentions INTEGER[] NOT NULL,
     ranks SMALLINT[] NOT NULL,
     PRIMARY KEY (ticker, day)
   ) WITH (fillfactor = 70); -- rows are updated in place up to 48 times a day; spare page space keeps those updates cheap
   CREATE INDEX ticker_days_day_idx ON ticker_days(day);
   ALTER TABLE collection_runs ADD COLUMN details JSONB;
   -- runs collected before this migration stored only the watchlist + top 100 in the old layout
   UPDATE collection_runs SET details = '{"legacy": true}'::jsonb WHERE kind = 'apewisdom';

   INSERT INTO market_days (day, market, tickers)
   SELECT d.day, array_agg(r.market ORDER BY s.slot), array_agg(r.tk::smallint ORDER BY s.slot)
   FROM (SELECT DISTINCT (started_at AT TIME ZONE 'UTC')::date AS day FROM collection_runs WHERE kind = 'apewisdom' AND status = 'success') d
   CROSS JOIN generate_series(0, 47) AS s(slot)
   LEFT JOIN LATERAL (
     SELECT c.market_total_mentions AS market, c.tickers_seen AS tk FROM collection_runs c
     WHERE c.kind = 'apewisdom' AND c.status = 'success' AND (c.started_at AT TIME ZONE 'UTC')::date = d.day
       AND floor((extract(hour FROM c.started_at AT TIME ZONE 'UTC') * 60 + extract(minute FROM c.started_at AT TIME ZONE 'UTC')) / 30) = s.slot
     ORDER BY c.started_at DESC LIMIT 1
   ) r ON true
   GROUP BY d.day;

   INSERT INTO ticker_days (ticker, day, mentions, ranks)
   SELECT x.ticker, x.day,
          (SELECT array_agg(CASE WHEN md.market[s.slot + 1] IS NULL THEN NULL ELSE coalesce(v.mentions, 0) END ORDER BY s.slot)
             FROM generate_series(0, 47) AS s(slot)
             LEFT JOIN LATERAL (
               SELECT sn.mentions FROM snapshots sn
               WHERE sn.ticker = x.ticker AND (sn.fetched_at AT TIME ZONE 'UTC')::date = x.day
                 AND floor((extract(hour FROM sn.fetched_at AT TIME ZONE 'UTC') * 60 + extract(minute FROM sn.fetched_at AT TIME ZONE 'UTC')) / 30) = s.slot
               ORDER BY sn.fetched_at DESC LIMIT 1) v ON true),
          (SELECT array_agg(v.rank::smallint ORDER BY s.slot)
             FROM generate_series(0, 47) AS s(slot)
             LEFT JOIN LATERAL (
               SELECT sn.rank FROM snapshots sn
               WHERE sn.ticker = x.ticker AND (sn.fetched_at AT TIME ZONE 'UTC')::date = x.day
                 AND floor((extract(hour FROM sn.fetched_at AT TIME ZONE 'UTC') * 60 + extract(minute FROM sn.fetched_at AT TIME ZONE 'UTC')) / 30) = s.slot
               ORDER BY sn.fetched_at DESC LIMIT 1) v ON true)
   FROM (SELECT DISTINCT ticker, (fetched_at AT TIME ZONE 'UTC')::date AS day FROM snapshots) x
   JOIN market_days md ON md.day = x.day;

   -- latest state of EVERY ticker, taken from the newest run's raw responses (names are only there)
   INSERT INTO tickers (ticker, name, first_seen, last_seen, fetched_at, ranked, rank, mentions, upvotes, rank_24h_ago, mentions_24h_ago)
   SELECT upper(trim(e->>'ticker')), e->>'name', c.started_at, c.started_at, c.started_at, true,
          (e->>'rank')::int, (e->>'mentions')::int, nullif(e->>'upvotes', '')::int,
          nullif(e->>'rank_24h_ago', '')::int, nullif(e->>'mentions_24h_ago', '')::int
   FROM collection_runs c JOIN raw_snapshots rs ON rs.run_id = c.id, jsonb_array_elements(rs.payload->'results') e
   WHERE c.id = (SELECT id FROM collection_runs WHERE kind = 'apewisdom' AND status = 'success'
                  AND EXISTS (SELECT 1 FROM raw_snapshots r2 WHERE r2.run_id = collection_runs.id)
                 ORDER BY started_at DESC LIMIT 1)
   ON CONFLICT DO NOTHING;
   INSERT INTO tickers (ticker, name, first_seen, last_seen, fetched_at, ranked, mentions)
   SELECT w.ticker, w.name, now(), now(), now(), false, 0 FROM watchlist w ON CONFLICT DO NOTHING;

   DROP TABLE snapshots;`,

  // Wikipedia page views (supplement to Reddit mentions): ticker -> article mapping, and daily views stored one row
  // per article per month with 31 day slots (NULL = no data for that day)
  `CREATE TABLE wiki_pages (
     ticker TEXT PRIMARY KEY,
     article TEXT,
     status TEXT NOT NULL,
     confidence TEXT NOT NULL,
     source TEXT NOT NULL DEFAULT 'auto',
     extract TEXT,
     rejected_article TEXT,
     checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE TABLE wiki_months (
     article TEXT NOT NULL,
     month DATE NOT NULL,
     views INTEGER[] NOT NULL,
     PRIMARY KEY (article, month)
   );`,

  // The matcher improved (entities, parentheticals, fund names): retry automatic matches that did not resolve
  `UPDATE wiki_pages SET checked_at = '2000-01-01' WHERE source = 'auto' AND status <> 'resolved';`,

  // Daily prices for the tracked stocks (and the SPY benchmark) and how far each ticker is synced
  `CREATE TABLE prices (
     ticker TEXT NOT NULL,
     day DATE NOT NULL,
     open DOUBLE PRECISION NOT NULL,
     high DOUBLE PRECISION NOT NULL,
     low DOUBLE PRECISION NOT NULL,
     close DOUBLE PRECISION NOT NULL,
     adj_close DOUBLE PRECISION NOT NULL,
     volume DOUBLE PRECISION NOT NULL,
     source TEXT NOT NULL,
     PRIMARY KEY (ticker, day)
   );
   CREATE TABLE price_sync (
     ticker TEXT PRIMARY KEY,
     full_at TIMESTAMPTZ,
     last_day DATE,
     source TEXT,
     error TEXT,
     checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,

  // Research results, the forward ledger of Reddit spikes, and the (unused) placeholder for alert channels
  `CREATE TABLE validation_runs (
     id SERIAL PRIMARY KEY,
     kind TEXT NOT NULL,
     ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     params JSONB NOT NULL,
     results JSONB NOT NULL
   );
   CREATE INDEX validation_runs_kind_idx ON validation_runs(kind, ran_at DESC);
   CREATE TABLE spike_events (
     id SERIAL PRIMARY KEY,
     ticker TEXT NOT NULL,
     detected_at TIMESTAMPTZ NOT NULL,
     label TEXT NOT NULL,
     ratio DOUBLE PRECISION,
     z DOUBLE PRECISION,
     mentions INTEGER,
     baseline DOUBLE PRECISION,
     explanation TEXT,
     wiki_label TEXT,
     run_id INTEGER,
     entry_day DATE,
     entry_open DOUBLE PRECISION,
     outcomes JSONB,
     outcomes_at TIMESTAMPTZ,
     alerted_at TIMESTAMPTZ
   );
   CREATE INDEX spike_events_ticker_idx ON spike_events(ticker, detected_at DESC);
   -- Placeholder only: nothing reads or sends from this yet (Slack incoming webhook is the planned first channel)
   CREATE TABLE alert_channels (
     id SERIAL PRIMARY KEY,
     type TEXT NOT NULL,
     enabled BOOLEAN NOT NULL DEFAULT false,
     config JSONB NOT NULL DEFAULT '{}',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,

  // Every leaderboard stock is tracked on equal terms, so the watchlist goes. Names stored with HTML entities
  // ("S&amp;P") are tidied now (new collections store plain text) and unmatched Wikipedia lookups are retried.
  `DROP TABLE watchlist;
   UPDATE tickers SET name = replace(replace(replace(replace(name, '&amp;', '&'), '&quot;', '"'), '&lt;', '<'), '&gt;', '>') WHERE name LIKE '%&%;%';
   UPDATE wiki_pages SET checked_at = 'epoch' WHERE source = 'auto' AND status <> 'resolved';`,

  // Two forward-test ledgers: Reddit spikes and Wikipedia spikes
  `ALTER TABLE spike_events ADD COLUMN source TEXT NOT NULL DEFAULT 'reddit';`,

  // Compact price storage (parallel arrays per ticker instead of a row per day) so five years for thousands of stocks fits easily;
  // every ticker is re-fetched once with the longer history
  `CREATE TABLE bars (
     ticker TEXT PRIMARY KEY,
     days SMALLINT[] NOT NULL,
     open REAL[] NOT NULL,
     close REAL[] NOT NULL,
     volume REAL[] NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   INSERT INTO bars (ticker, days, open, close, volume)
   SELECT ticker, array_agg((day - DATE '1970-01-01')::smallint ORDER BY day), array_agg(open::real ORDER BY day),
          array_agg(close::real ORDER BY day), array_agg(volume::real ORDER BY day)
   FROM prices GROUP BY ticker;
   DROP TABLE prices;
   UPDATE price_sync SET full_at = NULL;`,
];

function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new Pool({ connectionString, max: 10 });
}

async function migrate(pool) {
  const client = await pool.connect();
  try {
    // Serialise concurrent boots (e.g. overlapping deploys) on an advisory lock
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
    const { rows } = await client.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
    for (let v = rows[0].v + 1; v <= migrations.length; v++) {
      await client.query('BEGIN');
      try {
        await client.query(migrations[v - 1]);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

module.exports = { createPool, migrate };
