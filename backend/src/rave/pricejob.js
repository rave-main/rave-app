// The scheduled price job: top up daily prices (Yahoo Finance) for every stock on the leaderboard plus the SPY benchmark.
const { listStocks } = require('./tracked');
const prices = require('./prices');

const BENCHMARK = 'SPY';
const RETRY_FAILED_DAYS = 3;
const SOURCE_DOWN_AFTER = 10; // this many failures in a row means Yahoo itself is failing, not one odd ticker

async function runPrices(pool, { log = console, deadlineMs = 9 * 60 * 1000, pauseMs = 400, fetchImpl = fetch, now = Date.now() } = {}) {
  const started = Date.now();
  const opts = { fetchImpl, retryDelayMs: pauseMs * 4 };
  const tracked = await listStocks(pool); // one entry per company (share classes merged)
  const { rows: index } = await pool.query('SELECT ticker FROM universe');
  const universe = [...new Set([BENCHMARK, ...tracked.map((t) => t.ticker), ...index.map((i) => i.ticker)])];
  const { rows: sync } = await pool.query('SELECT ticker, full_at, last_day::text AS last_day, error, checked_at FROM price_sync WHERE ticker = ANY($1)', [universe]);
  const byTicker = new Map(sync.map((s) => [s.ticker, s]));
  const today = prices.isoDay(now);
  const details = { universe: universe.length, fetched: 0, rowsAdded: 0, fullRefreshes: 0, skipped: 0, errors: [], partial: false };
  let attempted = 0;
  let streak = 0;

  // Benchmark first, then the rest; tickers never synced come before ones that only need a top-up
  const ordered = [BENCHMARK, ...universe.filter((t) => t !== BENCHMARK).sort((a, b) => Number(byTicker.has(a)) - Number(byTicker.has(b)))];
  for (const ticker of ordered) {
    if (Date.now() - started > deadlineMs) { details.partial = true; break; }
    const s = byTicker.get(ticker);
    const needsFull = !s || !s.full_at || now - new Date(s.full_at).getTime() > prices.FULL_REFRESH_DAYS * prices.DAY_MS;
    // overlap the last 10 days on a top-up so late corrections are picked up
    const from = needsFull ? prices.isoDay(now - prices.BACKFILL_DAYS * prices.DAY_MS) : prices.isoDay(Date.parse(`${s.last_day}T00:00:00Z`) - 10 * prices.DAY_MS);
    if (!needsFull && s.last_day >= today) { details.skipped++; continue; }
    // a ticker Yahoo does not know (or rejected) is retried every few days, not on every run
    if (s?.error && now - new Date(s.checked_at).getTime() < RETRY_FAILED_DAYS * prices.DAY_MS) { details.skipped++; continue; }
    attempted++;
    try {
      const rows = await prices.fetchPrices(ticker, from, today, opts);
      details.rowsAdded += await prices.savePrices(pool, ticker, rows);
      const last = rows.length ? rows[rows.length - 1].day : s?.last_day || null;
      await pool.query(
        `INSERT INTO price_sync (ticker, full_at, last_day, source, error, checked_at) VALUES ($1, $2, $3, $4, NULL, now())
         ON CONFLICT (ticker) DO UPDATE SET full_at = coalesce($2, price_sync.full_at), last_day = coalesce($3, price_sync.last_day), source = $4, error = NULL, checked_at = now()`,
        [ticker, needsFull ? new Date(now) : null, last, 'yahoo']
      );
      details.fetched++;
      streak = 0;
      if (needsFull) details.fullRefreshes++;
    } catch (err) {
      const msg = `${ticker}: ${String(err.message).slice(0, 160)}`;
      details.errors.push(msg);
      streak++;
      await pool.query(
        `INSERT INTO price_sync (ticker, error, checked_at) VALUES ($1, $2, now()) ON CONFLICT (ticker) DO UPDATE SET error = $2, checked_at = now()`,
        [ticker, msg]
      );
    }
    if (streak >= SOURCE_DOWN_AFTER) break;
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  details.errorCount = details.errors.length;
  details.errors = details.errors.slice(0, 8);
  if (streak >= SOURCE_DOWN_AFTER || (attempted >= 3 && details.fetched === 0)) {
    throw new Error(`Price fetches failing (${details.errorCount} of ${attempted} tickers), e.g. ${details.errors[0]}`);
  }
  return details;
}

module.exports = { runPrices, BENCHMARK };
