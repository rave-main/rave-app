// Upcoming company results dates from Yahoo Finance (a cookie and a "crumb" are needed for its quote-summary endpoint). Results days are the
// biggest known cause of big price moves, so the Radar shows "results due" and the research can separate them. Dates that have passed stay in
// the table, so a history of real results dates builds up from the day this was added; before that, the research estimates results days from
// volume surges (see strategy2.js).
const { BROWSER_UA, yahooSymbol } = require('./prices');
const { listStocks } = require('./tracked');

const CHECK_EVERY_DAYS = 5;

async function getSession(fetchImpl = fetch) {
  const first = await fetchImpl('https://fc.yahoo.com/', { headers: { 'User-Agent': BROWSER_UA }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const cookies = (first.headers.getSetCookie ? first.headers.getSetCookie() : []).map((c) => c.split(';')[0]).filter(Boolean);
  if (!cookies.length) throw new Error('Yahoo gave no session cookie');
  const cookie = cookies.join('; ');
  const res = await fetchImpl('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': BROWSER_UA, Cookie: cookie }, signal: AbortSignal.timeout(20000) });
  const crumb = (await res.text()).trim();
  if (!res.ok || !crumb || crumb.length > 40 || /[<{]/.test(crumb)) throw new Error(`Yahoo crumb request failed (HTTP ${res.status})`);
  return { cookie, crumb };
}

// The next results date (YYYY-MM-DD), or null when none is announced. Throws on request failure.
async function fetchNextEarnings(ticker, session, fetchImpl = fetch) {
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol(ticker))}?modules=calendarEvents&crumb=${encodeURIComponent(session.crumb)}`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': BROWSER_UA, Cookie: session.cookie }, signal: AbortSignal.timeout(20000) });
  if (res.status === 404) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error(`Yahoo quote summary: HTTP ${res.status} ${body?.finance?.error?.description || body?.quoteSummary?.error?.description || ''}`.trim());
    e.status = res.status;
    throw e;
  }
  const raw = body?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate;
  if (!Array.isArray(raw) || !raw.length || raw[0].raw === undefined) return null;
  return new Date(raw[0].raw * 1000).toISOString().slice(0, 10);
}

async function runEarnings(pool, { log = console, deadlineMs = 8 * 60 * 1000, pauseMs = 300, fetchImpl = fetch, now = Date.now() } = {}) {
  const started = Date.now();
  const [stocks, { rows: index }, { rows: checked }] = await Promise.all([
    listStocks(pool), pool.query('SELECT ticker FROM universe WHERE active'), pool.query('SELECT ticker, max(fetched_at) AS at FROM earnings_checks GROUP BY ticker'),
  ]);
  const last = new Map(checked.map((c) => [c.ticker, new Date(c.at).getTime()]));
  const all = [...new Set([...stocks.map((s) => s.ticker), ...index.map((i) => i.ticker)])];
  const due = all.filter((t) => !last.has(t) || now - last.get(t) > CHECK_EVERY_DAYS * 86400000).sort((a, b) => (last.get(a) || 0) - (last.get(b) || 0));
  const details = { stocks: all.length, due: due.length, checked: 0, withDate: 0, errors: [], partial: false };
  if (!due.length) return details;
  const session = await getSession(fetchImpl);
  let streak = 0;
  for (const ticker of due) {
    if (Date.now() - started > deadlineMs) { details.partial = true; break; }
    try {
      const day = await fetchNextEarnings(ticker, session, fetchImpl);
      await pool.query('INSERT INTO earnings_checks (ticker, fetched_at, next_day) VALUES ($1, now(), $2) ON CONFLICT (ticker) DO UPDATE SET fetched_at = now(), next_day = $2', [ticker, day]);
      if (day) {
        // an announced date replaces earlier estimates that have not happened yet; dates in the past are history and stay
        await pool.query(`DELETE FROM earnings_dates WHERE ticker = $1 AND day > current_date AND day <> $2`, [ticker, day]);
        await pool.query('INSERT INTO earnings_dates (ticker, day) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ticker, day]);
        details.withDate++;
      }
      details.checked++;
      streak = 0;
    } catch (err) {
      details.errors.push(`${ticker}: ${String(err.message).slice(0, 100)}`);
      streak++;
      if (streak >= 10) break; // Yahoo itself is refusing: stop and let the next run start a fresh session
    }
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  details.errorCount = details.errors.length;
  details.errors = details.errors.slice(0, 8);
  if (streak >= 10 || (details.checked === 0 && details.errorCount > 0)) throw new Error(`Yahoo results dates failing, e.g. ${details.errors[0]}`);
  return details;
}

module.exports = { runEarnings, getSession, fetchNextEarnings };
