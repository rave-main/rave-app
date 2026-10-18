// Every stock on the ApeWisdom leaderboard is tracked and scored on equal terms. Share classes of one company
// (GOOGL and GOOG) are merged into one row (see share-classes.js). Quiet stocks are not hidden, they are labelled
// "Low volume" because they get too few mentions to rate.
const { loadSeries } = require('./series');
const { scoreStock } = require('./scoring');
const { loadWikiSeries } = require('./wiki');
const { loadPrices } = require('./prices');
const { shareClassGroups } = require('./share-classes');
const { displayName } = require('./text');

// every stock seen on the leaderboard in the last week
const ALL_SQL = `
  SELECT t.ticker, t.name, t.fetched_at AS "fetchedAt", t.ranked, t.rank, t.mentions, t.upvotes,
         t.rank_24h_ago AS "rank24hAgo", t.mentions_24h_ago AS "mentions24hAgo"
  FROM tickers t WHERE t.last_seen >= now() - interval '7 days'
  ORDER BY t.mentions DESC, t.ticker`;

// ApeWisdom's own comparison with 24 hours earlier; available from the very first reading
function dayOverDay(r) {
  if (r.mentions24hAgo === null || r.mentions24hAgo === undefined) return null;
  return { change: r.mentions - r.mentions24hAgo, ratio: r.mentions24hAgo > 0 ? r.mentions / r.mentions24hAgo : null };
}

const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
const minOf = (xs) => { const v = xs.filter((x) => x !== null && x !== undefined); return v.length ? Math.min(...v) : null; };

// One row per company: the main ticker of each share-class group stands for the whole group
async function listStocks(pool) {
  const { rows } = await pool.query(ALL_SQL);
  const groups = shareClassGroups(rows);
  const byTicker = new Map(rows.map((r) => [r.ticker, r]));
  const out = [];
  for (const r of rows) {
    const members = groups.get(r.ticker);
    if (!members) { out.push({ ...r, name: displayName(r.name, r.ticker), tickers: [r.ticker], label: r.ticker }); continue; }
    if (members[0] !== r.ticker) continue; // only the main ticker produces the row
    const parts = members.map((t) => byTicker.get(t)).filter(Boolean);
    out.push({
      ...r,
      name: displayName(r.name, r.ticker),
      mentions: sum(parts.map((p) => p.mentions)), upvotes: sum(parts.map((p) => p.upvotes)),
      mentions24hAgo: parts.every((p) => p.mentions24hAgo === null) ? null : sum(parts.map((p) => p.mentions24hAgo)),
      ranked: parts.some((p) => p.ranked), rank: minOf(parts.map((p) => p.rank)),
      tickers: members, label: members.join(' / '),
    });
  }
  out.sort((a, b) => b.mentions - a.mentions || a.ticker.localeCompare(b.ticker));
  return out;
}

// Adds the readings of the other share classes onto the main ticker's series (same timestamps: one collection run)
function mergeSeries(seriesList) {
  const [main, ...rest] = seriesList;
  if (!rest.length) return main;
  const extra = rest.map((s) => new Map(s.map((p) => [p.t, p])));
  return main.map((p) => {
    let mentions = p.mentions, rank = p.rank, ranked = p.ranked;
    for (const m of extra) {
      const q = m.get(p.t);
      if (!q) continue;
      mentions += q.mentions;
      ranked = ranked || q.ranked;
      rank = rank === null ? q.rank : q.rank === null ? rank : Math.min(rank, q.rank);
    }
    return { ...p, mentions, rank, ranked };
  });
}

// Latest closing price in US dollars and the change over 1 and 5 trading days
function priceSummary(rows) {
  if (!rows || !rows.length) return null;
  const last = rows[rows.length - 1];
  const back = (n) => (rows.length > n ? last.close / rows[rows.length - 1 - n].close - 1 : null);
  return { close: last.close, day: last.day, change1d: back(1), change1w: back(5) };
}

let cache = { key: null, value: null };

// Scores for every stock, cached until the next collection (or Wikipedia, or price) run lands
async function scoredStocks(pool) {
  const { rows: [{ run }] } = await pool.query(
    `SELECT coalesce(max(id)::text, '0') || '|' || coalesce(max(started_at)::text, '') || '|' ||
            (SELECT coalesce(max(id), 0) FROM collection_runs WHERE kind = 'wikipedia' AND status = 'success') || '|' ||
            (SELECT coalesce(max(id), 0) FROM collection_runs WHERE kind = 'prices' AND status = 'success') AS run
     FROM collection_runs WHERE kind = 'apewisdom' AND status = 'success'`
  );
  if (cache.key === run && cache.value) return cache.value;
  const stocks = await listStocks(pool);
  const all = [...new Set(stocks.flatMap((s) => s.tickers))];
  const series = await loadSeries(pool, all);
  const mains = stocks.map((s) => s.ticker);
  const { rows: mapped } = await pool.query('SELECT ticker, article, status, confidence, source FROM wiki_pages WHERE ticker = ANY($1)', [mains]);
  const wikiOf = new Map(mapped.map((m) => [m.ticker, m]));
  const wseries = await loadWikiSeries(pool, [...new Set(mapped.filter((m) => m.article).map((m) => m.article))]);
  const prices = await loadPrices(pool, mains, { fromDay: new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10) });
  const AT_LEAST_RISING = ['Rising', 'Hot', 'Extreme'];
  const value = stocks.map((r) => {
    const merged = mergeSeries(r.tickers.map((t) => series.get(t)));
    if (merged.length) Object.assign(merged[merged.length - 1], { rank24hAgo: r.rank24hAgo, mentions24hAgo: r.mentions24hAgo });
    const scores = scoreStock(merged, { ticker: r.ticker });
    const m = wikiOf.get(r.ticker);
    const wikiScores = m?.article ? scoreStock(wseries.get(m.article) || [], { ticker: r.ticker, source: 'wiki' }) : null;
    const redditUp = AT_LEAST_RISING.includes(scores.short.label);
    const wikiUp = Boolean(wikiScores) && AT_LEAST_RISING.includes(wikiScores.short.label);
    return {
      ...r,
      dayOverDay: dayOverDay(r),
      spark: merged.slice(-48).map((p) => p.mentions), // about the last 24 hours
      price: priceSummary(prices.get(r.ticker)),
      scores,
      wiki: m ? { article: m.article, status: m.status, confidence: m.confidence, source: m.source, scores: wikiScores } : { article: null, status: 'pending', confidence: 'none', source: 'auto', scores: null },
      // both signals agree when Reddit and Wikipedia are each at Rising or above (short horizon)
      agreement: redditUp && wikiUp ? 'both' : redditUp ? 'reddit' : wikiUp ? 'wiki' : 'none',
    };
  });
  cache = { key: run, value };
  return value;
}

module.exports = { scoredStocks, listStocks, mergeSeries, priceSummary, dayOverDay, ALL_SQL };
