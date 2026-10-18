// Research: does attention come before unusual price moves? Two complementary tests.
//  1. BACKTEST on Wikipedia page views (years of history exist now): events -> event study vs SPY, lead-lag.
//  2. FORWARD LEDGER for Reddit mentions (no history exists): every Hot/Extreme spike is recorded the moment it is
//     seen, entry is fixed at the next market open, and outcomes are filled in as prices arrive. Parameters are frozen,
//     so it is an honest out-of-sample test that builds itself.
// Caveat shown on the page: the stocks tested are the ones tracked TODAY (chosen because they are talked about now),
// which favours stocks that did something. Results are research evidence, not investment advice.
const v = require('./validation');
const { loadWikiSeries } = require('./wiki');
const { loadPrices } = require('./prices');
const { scoredStocks, listStocks } = require('./tracked');
const { median } = require('./stats');

const BENCHMARK = 'SPY';
const DAY = 86400000;
const MIN_PRICE_ROWS = 300;
const MIN_WIKI_DAYS = 400;
const MARKET_OPEN_UTC_MS = (13 * 60 + 30) * 60000; // the earliest the US market opens (EDT); entry never precedes a signal

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// ---------- 1. backtest ----------
async function loadBacktestData(pool) {
  const mains = (await listStocks(pool)).map((s) => s.ticker); // one ticker per company
  const { rows: mapped } = await pool.query(
    `SELECT p.ticker, p.article, coalesce(t.mentions, 0) AS mentions
     FROM wiki_pages p LEFT JOIN tickers t ON t.ticker = p.ticker
     WHERE p.article IS NOT NULL AND p.ticker <> $1 AND p.ticker = ANY($2) ORDER BY t.mentions DESC NULLS LAST, p.ticker`,
    [BENCHMARK, mains]
  );
  // two tickers that share an article (GOOG/GOOGL) are one attention series: count it once
  const seen = new Set();
  const unique = mapped.filter((m) => (seen.has(m.article) ? false : seen.add(m.article)));
  const [wiki, prices] = await Promise.all([
    loadWikiSeries(pool, unique.map((m) => m.article), { days: 2400 }),
    loadPrices(pool, [BENCHMARK, ...unique.map((m) => m.ticker)]),
  ]);
  const bench = prices.get(BENCHMARK);
  const series = [];
  for (const m of unique) {
    const pts = wiki.get(m.article) || [];
    const px = prices.get(m.ticker) || [];
    if (pts.length < MIN_WIKI_DAYS || px.length < MIN_PRICE_ROWS) continue;
    const first = pts[0].t;
    const values = Array(Math.round((pts[pts.length - 1].t - first) / DAY) + 1).fill(null);
    for (const p of pts) values[Math.round((p.t - first) / DAY)] = p.mentions;
    series.push({ ticker: m.ticker, article: m.article, startDay: dayOf(first), values, prices: px });
  }
  return { series, bench };
}

const CAVEATS = [
  'We only test shares that are popular today. Popular shares are more likely to be ones that already did something, so good-looking results deserve extra caution.',
  'Wikipedia only publishes a day\'s page views after the day ends, so the realistic purchase is at the market open at least 2 days after the spike (an optimistic 1-day case is shown too).',
  'Gains and losses are measured against the overall market (an S&P 500 fund, SPY) from the market open on the purchase day to the close 1, 5 and 20 trading days later. Trading costs are not included.',
  'Wikipedia page views are a different signal from Reddit mentions. Reddit has no history yet, so it is tested going forward, in the forward test.',
];

async function runResearch(pool, { log = console, B = 1000 } = {}) {
  const started = Date.now();
  const { series, bench } = await loadBacktestData(pool);
  if (series.length < 8 || bench.length < MIN_PRICE_ROWS) {
    const reason = `needs at least 8 stocks with a Wikipedia article and ${MIN_PRICE_ROWS}+ days of prices (have ${series.length}); the benchmark ${BENCHMARK} has ${bench.length} days`;
    await pool.query(`INSERT INTO validation_runs (kind, params, results) VALUES ('wiki_backtest', $1, $2)`, [JSON.stringify({ B }), JSON.stringify({ status: 'insufficient', reason, generatedAt: new Date().toISOString() })]);
    return { status: 'insufficient', reason };
  }
  const base = { series, bench, B };
  const conservative = await v.eventStudy({ ...base, lagDays: 2, seed: 11 });
  const optimistic = await v.eventStudy({ ...base, lagDays: 1, seed: 12, horizons: [1, 5, 20] });
  const leadLag = await v.leadLag({ series, bench, maxLag: 10, B: Math.min(B, 300), seed: 13 });
  const days = series.flatMap((s) => [s.startDay]).sort();
  const results = {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    signal: 'Wikipedia page views (people, not bots). A spike is a day rated Hot or Extreme, using the same rule as the Radar.',
    universe: { tickers: series.length, firstDay: days[0], lastDay: bench[bench.length - 1].day, list: series.map((s) => ({ ticker: s.ticker, article: s.article })) },
    conservative, optimistic, leadLag,
    verdict: { conservative: v.verdict(conservative), optimistic: v.verdict(optimistic) },
    caveats: CAVEATS,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  await pool.query(`INSERT INTO validation_runs (kind, params, results) VALUES ('wiki_backtest', $1, $2)`, [JSON.stringify({ B, lagDays: [2, 1], minLabel: 'Hot', cooldownDays: 10 }), JSON.stringify(results)]);
  return { status: 'ok', tickers: series.length, events: conservative.events, verdict: results.verdict.conservative.level, seconds: results.seconds };
}

// ---------- 2. forward ledger ----------
// Records Hot/Extreme Reddit spikes (short horizon, confirmed) for tracked stocks, once per stock per 7 days
async function recordSpikes(pool) {
  const stocks = await scoredStocks(pool);
  const { rows: [{ run }] } = await pool.query(`SELECT max(id) AS run FROM collection_runs WHERE kind = 'apewisdom' AND status = 'success'`);
  let added = 0;
  for (const s of stocks) {
    const sh = s.scores.short;
    if (sh.status !== 'ok' || !['Hot', 'Extreme'].includes(sh.label) || sh.unconfirmed) continue;
    const m = sh.adjusted || sh.raw;
    const { rowCount } = await pool.query(
      `INSERT INTO spike_events (ticker, detected_at, label, ratio, z, mentions, baseline, explanation, wiki_label, run_id)
       SELECT $1, now(), $2, $3, $4, $5, $6, $7, $8, $9
       WHERE NOT EXISTS (SELECT 1 FROM spike_events WHERE ticker = $1 AND detected_at > now() - interval '7 days')`,
      [s.ticker, sh.label, m.ratio, m.z, s.mentions, sh.raw.baselineMedian, sh.explanation, s.wiki?.scores?.short?.label || null, run]
    );
    added += rowCount;
  }
  return added;
}

// Entry = open of the first trading day that opens AFTER the signal time (13:30 UTC is the earliest US open)
function entryCandidateDay(detectedAt) {
  const t = new Date(detectedAt).getTime();
  const dayStart = Math.floor(t / DAY) * DAY;
  return dayOf(t - dayStart < MARKET_OPEN_UTC_MS ? dayStart : dayStart + DAY);
}

// Fills in entry and outcomes for ledger events as prices become available
async function updateLedger(pool) {
  const { rows: events } = await pool.query(
    `SELECT id, ticker, detected_at, outcomes FROM spike_events
     WHERE detected_at > now() - interval '120 days' AND (outcomes IS NULL OR jsonb_array_length(jsonb_path_query_array(outcomes, '$.*')) < 3)`
  );
  if (!events.length) return { updated: 0 };
  const tickers = [...new Set(events.map((e) => e.ticker))];
  const prices = await loadPrices(pool, [BENCHMARK, ...tickers], { fromDay: dayOf(Date.now() - 200 * DAY) });
  const bench = v.indexPrices(prices.get(BENCHMARK));
  let updated = 0;
  for (const ev of events) {
    const rows = prices.get(ev.ticker);
    if (!rows || rows.length < 5 || bench.n < 5) continue;
    const px = v.indexPrices(rows);
    const e = v.firstTradingOnOrAfter(px, entryCandidateDay(ev.detected_at));
    if (e < 0) continue;
    const outcomes = {};
    for (const h of v.HORIZONS) {
      const o = v.outcomeAt(px, bench, e, h);
      if (o) outcomes[h] = o;
    }
    const known = ev.outcomes ? Object.keys(ev.outcomes).length : 0;
    if (Object.keys(outcomes).length === known && known > 0) continue;
    await pool.query(`UPDATE spike_events SET entry_day = $2, entry_open = $3, outcomes = $4, outcomes_at = now() WHERE id = $1`, [ev.id, rows[e].day, rows[e].open, JSON.stringify(outcomes)]);
    updated++;
  }
  return { updated };
}

async function ledgerSummary(pool) {
  const { rows: events } = await pool.query(
    `SELECT id, ticker, detected_at AS "detectedAt", label, ratio, z, mentions, baseline, wiki_label AS "wikiLabel", entry_day::text AS "entryDay", entry_open AS "entryOpen", outcomes, explanation
     FROM spike_events ORDER BY detected_at DESC LIMIT 200`
  );
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const per = {};
  for (const h of v.HORIZONS) {
    const os = events.map((e) => e.outcomes?.[h]).filter(Boolean);
    per[h] = os.length
      ? { n: os.length, meanAbnormal: mean(os.map((o) => o.abn)), medianAbnormal: median(os.map((o) => o.abn)), hitRate: mean(os.map((o) => (o.abn > 0 ? 1 : 0))), meanAbsMove: mean(os.map((o) => o.absAbn)) }
      : { n: 0 };
  }
  const needed = 30;
  return { total: events.length, withFiveDayOutcome: per[5].n, needed, progress: Math.min(1, per[5].n / needed), perHorizon: per, events: events.slice(0, 50) };
}

module.exports = { runResearch, loadBacktestData, recordSpikes, updateLedger, ledgerSummary, entryCandidateDay, BENCHMARK, CAVEATS };
