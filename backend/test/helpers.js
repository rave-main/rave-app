const request = require('supertest');
const { createApp } = require('../src/app');
const { createPool, migrate } = require('../src/db');
const { slotOf, SLOTS } = require('../src/rave/store');

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/rave_test';

// Clears all RAVE data but keeps the seeded watchlist (and gives each watchlist stock its `tickers` row back)
async function resetRave(pool) {
  await pool.query('TRUNCATE collection_runs, raw_snapshots, ticker_days, market_days, tickers, wiki_pages, wiki_months RESTART IDENTITY CASCADE');
  await pool.query(
    `INSERT INTO tickers (ticker, name, first_seen, last_seen, fetched_at, ranked, mentions)
     SELECT ticker, name, now(), now(), now(), false, 0 FROM watchlist`
  );
}

async function setup() {
  const pool = createPool(TEST_DB);
  await migrate(pool);
  await pool.query('TRUNCATE users, sessions, notes RESTART IDENTITY CASCADE');
  await resetRave(pool);
  const app = createApp({ pool, frontendOrigin: 'https://app.example,https://*-team.vercel.app' });
  return { pool, app };
}

// Registers a user and returns a supertest agent that carries their session cookie
async function signedInAgent(app, overrides = {}) {
  const agent = request.agent(app);
  const user = { name: 'Test User', email: `user${Math.random().toString(36).slice(2)}@example.com`, password: 'correct horse battery', ...overrides };
  const res = await agent.post('/api/auth/register').send(user).expect(201);
  return { agent, user: res.body, password: user.password };
}

// Writes synthetic history straight into the compact tables. `byTicker` maps ticker -> points {t, mentions, market}
// that all share one time grid (slot starts). `shiftToNow` moves the grid so its last point is the latest slot.
async function seedHistory(pool, byTicker, { shiftToNow = true } = {}) {
  const tickers = Object.keys(byTicker);
  const grid = byTicker[tickers[0]];
  const slotMs = 30 * 60 * 1000;
  const shift = shiftToNow ? Math.floor(Date.now() / slotMs) * slotMs - grid[grid.length - 1].t : 0;
  const days = new Map(); // day -> { market: [], tickers: {ticker: []} }
  grid.forEach((p, i) => {
    const { day, slot } = slotOf(new Date(Math.floor((p.t + shift) / slotMs) * slotMs));
    if (!days.has(day)) days.set(day, { market: Array(SLOTS).fill(null), per: Object.fromEntries(tickers.map((t) => [t, Array(SLOTS).fill(null)])) });
    const d = days.get(day);
    d.market[slot] = p.market;
    for (const t of tickers) d.per[t][slot] = byTicker[t][i].mentions;
  });
  const runIds = [];
  for (const [day, d] of days) {
    await pool.query('INSERT INTO market_days (day, market, tickers) VALUES ($1, $2, $3) ON CONFLICT (day) DO UPDATE SET market = EXCLUDED.market', [day, d.market, d.market.map((m) => (m === null ? null : 800))]);
    for (const t of tickers) {
      await pool.query(
        `INSERT INTO ticker_days (ticker, day, mentions, ranks) VALUES ($1, $2, $3, $4) ON CONFLICT (ticker, day) DO UPDATE SET mentions = EXCLUDED.mentions, ranks = EXCLUDED.ranks`,
        [t, day, d.per[t], d.per[t].map((m) => (m === null ? null : 5))]
      );
    }
    d.market.forEach((m, slot) => m !== null && runIds.push([day, slot, m]));
  }
  // one successful run per slot, so run-based features (freshness, scoring cache key) see the data
  const times = runIds.map(([day, slot]) => new Date(Date.parse(`${day}T00:00:00Z`) + slot * slotMs + 2 * 60000));
  await pool.query(
    `INSERT INTO collection_runs (kind, status, started_at, finished_at, pages_fetched, pages_total, tickers_seen, rows_written, market_total_mentions)
     SELECT 'apewisdom', 'success', t, t + interval '8 seconds', 9, 9, 800, 800, m FROM unnest($1::timestamptz[], $2::int[]) AS x(t, m)`,
    [times, runIds.map((r) => r[2])]
  );
  for (const t of tickers) {
    const last = byTicker[t][byTicker[t].length - 1];
    await pool.query(
      `INSERT INTO tickers (ticker, name, first_seen, last_seen, fetched_at, ranked, rank, mentions, rank_24h_ago, mentions_24h_ago)
       VALUES ($1, $1, now(), now(), now(), $2, 5, $3, 6, $4)
       ON CONFLICT (ticker) DO UPDATE SET ranked = EXCLUDED.ranked, rank = 5, mentions = EXCLUDED.mentions, fetched_at = now(), rank_24h_ago = 6, mentions_24h_ago = EXCLUDED.mentions_24h_ago`,
      [t, last.mentions > 0, last.mentions, Math.max(0, last.mentions - 3)]
    );
  }
  return { shift };
}

module.exports = { setup, signedInAgent, request, resetRave, seedHistory };
