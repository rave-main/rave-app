// The scheduled price job: top up daily prices for every tracked stock plus the SPY benchmark.
const { TRACKED_SQL, TRACK_MIN_PEAK } = require('./tracked');
const prices = require('./prices');

const BENCHMARK = 'SPY';

async function runPrices(pool, { log = console, deadlineMs = 9 * 60 * 1000, pauseMs = 400, fetchImpl = fetch, now = Date.now(), sources } = {}) {
  const started = Date.now();
  const opts = { fetchImpl, retryDelayMs: pauseMs * 4, sources };
  const { rows: tracked } = await pool.query(TRACKED_SQL, [TRACK_MIN_PEAK]);
  const universe = [...new Set([BENCHMARK, ...tracked.map((t) => t.ticker)])];
  const { rows: sync } = await pool.query('SELECT ticker, full_at, last_day::text AS last_day FROM price_sync WHERE ticker = ANY($1)', [universe]);
  const byTicker = new Map(sync.map((s) => [s.ticker, s]));
  const today = prices.isoDay(now);
  const details = { universe: universe.length, fetched: 0, rowsAdded: 0, fullRefreshes: 0, skipped: 0, errors: [], sources: {}, partial: false };
  let attempted = 0;

  // Benchmark first, then the rest; tickers never synced come before ones that only need a top-up
  const ordered = [BENCHMARK, ...universe.filter((t) => t !== BENCHMARK).sort((a, b) => Number(byTicker.has(a)) - Number(byTicker.has(b)))];
  for (const ticker of ordered) {
    if (Date.now() - started > deadlineMs) { details.partial = true; break; }
    const s = byTicker.get(ticker);
    const needsFull = !s || !s.full_at || now - new Date(s.full_at).getTime() > prices.FULL_REFRESH_DAYS * prices.DAY_MS;
    // overlap the last 10 days on a top-up so late corrections are picked up
    const from = needsFull ? prices.isoDay(now - prices.BACKFILL_DAYS * prices.DAY_MS) : prices.isoDay(Date.parse(`${s.last_day}T00:00:00Z`) - 10 * prices.DAY_MS);
    if (!needsFull && s.last_day >= today) { details.skipped++; continue; }
    attempted++;
    try {
      const { rows, source } = await prices.fetchPrices(ticker, from, today, opts);
      details.sources[source] = (details.sources[source] || 0) + 1;
      details.rowsAdded += await prices.savePrices(pool, ticker, rows, source);
      const last = rows.length ? rows[rows.length - 1].day : s?.last_day || null;
      await pool.query(
        `INSERT INTO price_sync (ticker, full_at, last_day, source, error, checked_at) VALUES ($1, $2, $3, $4, NULL, now())
         ON CONFLICT (ticker) DO UPDATE SET full_at = coalesce($2, price_sync.full_at), last_day = coalesce($3, price_sync.last_day), source = $4, error = NULL, checked_at = now()`,
        [ticker, needsFull ? new Date(now) : null, last, source]
      );
      details.fetched++;
      if (needsFull) details.fullRefreshes++;
    } catch (err) {
      const msg = `${ticker}: ${String(err.message).slice(0, 160)}`;
      details.errors.push(msg);
      await pool.query(
        `INSERT INTO price_sync (ticker, error, checked_at) VALUES ($1, $2, now()) ON CONFLICT (ticker) DO UPDATE SET error = $2, checked_at = now()`,
        [ticker, msg]
      );
    }
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  details.errorCount = details.errors.length;
  details.errors = details.errors.slice(0, 8);
  if (attempted >= 3 && details.errorCount >= Math.max(3, attempted * 0.5)) {
    throw new Error(`Price fetches failing for ${details.errorCount} of ${attempted} tickers, e.g. ${details.errors[0]}`);
  }
  return details;
}

module.exports = { runPrices, BENCHMARK };
