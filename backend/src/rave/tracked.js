// Every stock on the ApeWisdom leaderboard is tracked and scored on equal terms. Share classes of one company
// (GOOGL and GOOG) are merged into one row (see share-classes.js). Quiet stocks are not hidden, they are labelled
// "Low volume" because they get too few mentions to rate.
const { loadSeries } = require('./series');
const { scoreStock } = require('./scoring');
const { loadWikiSeries } = require('./wiki');
const { loadPrices } = require('./prices');
const { shareClassGroups } = require('./share-classes');
const { displayName } = require('./text');
const { stockKind } = require('./stock-kind');

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
    if (!members) { out.push({ ...r, name: displayName(r.name, r.ticker), kind: stockKind(r.ticker, r.name), tickers: [r.ticker], label: r.ticker }); continue; }
    if (members[0] !== r.ticker) continue; // only the main ticker produces the row
    const parts = members.map((t) => byTicker.get(t)).filter(Boolean);
    out.push({
      ...r,
      name: displayName(r.name, r.ticker), kind: stockKind(r.ticker, r.name),
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

// Latest closing price in US dollars, the change over 1, 5 and 20 trading days, and how jumpy the stock has been: the typical size
// of a 20-trading-day move (one standard deviation of daily moves over the last 60 sessions, scaled up). "ran" is set when the last
// 5 days already moved by more than 1.5 times what is normal for 5 days, i.e. the move may be over before you read about it.
function priceSummary(rows) {
  if (!rows || !rows.length) return null;
  const last = rows[rows.length - 1];
  const back = (n) => (rows.length > n ? last.close / rows[rows.length - 1 - n].close - 1 : null);
  const rets = [];
  for (let i = Math.max(1, rows.length - 60); i < rows.length; i++) if (rows[i - 1].close > 0 && rows[i].close > 0) rets.push(Math.log(rows[i].close / rows[i - 1].close));
  let vol = null;
  if (rets.length >= 30) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  }
  const change1w = back(5);
  return {
    close: last.close, day: last.day, change1d: back(1), change1w, change1m: back(20),
    swing20: vol === null ? null : vol * Math.sqrt(20),
    ran: vol !== null && change1w !== null && Math.abs(change1w) > 1.5 * vol * Math.sqrt(5),
  };
}

let cache = { key: null, value: null };

// Scores for every stock, cached until the next collection (or Wikipedia, or price) run lands
async function scoredStocks(pool) {
  const { rows: [{ run }] } = await pool.query(
    `SELECT coalesce(max(id)::text, '0') || '|' || coalesce(max(started_at)::text, '') || '|' ||
            (SELECT coalesce(max(id), 0) FROM collection_runs WHERE kind = 'wikipedia' AND status = 'success') || '|' ||
            (SELECT coalesce(max(id), 0) FROM collection_runs WHERE kind = 'prices' AND status = 'success') || '|' ||
            (SELECT coalesce(max(id), 0) FROM validation_runs WHERE kind = 'bigmove') AS run
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
  const prices = await loadPrices(pool, mains, { fromDay: new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10) });
  const { rows: due } = await pool.query(`SELECT ticker, min(day)::text AS day, (min(day) - current_date)::int AS days FROM earnings_dates WHERE ticker = ANY($1) AND day >= current_date GROUP BY ticker`, [mains]);
  const dueOf = new Map(due.map((d) => [d.ticker, { day: d.day, inDays: d.days }]));
  const { rows: [bm] } = await pool.query(`SELECT results FROM validation_runs WHERE kind = 'bigmove' ORDER BY ran_at DESC LIMIT 1`);
  const bigMove = bm?.results || null;
  const AT_LEAST_RISING = ['Rising', 'Hot', 'Extreme'];
  const value = stocks.map((r) => {
    const merged = mergeSeries(r.tickers.map((t) => series.get(t)));
    if (merged.length) Object.assign(merged[merged.length - 1], { rank24hAgo: r.rank24hAgo, mentions24hAgo: r.mentions24hAgo });
    const scores = scoreStock(merged, { ticker: r.ticker });
    const m = wikiOf.get(r.ticker);
    const wpts = m?.article ? wseries.get(m.article) || [] : [];
    const wikiScores = m?.article ? scoreStock(wpts, { ticker: r.ticker, source: 'wiki' }) : null;
    const views = wpts.length >= 2 ? { now: wpts[wpts.length - 1].mentions, before: wpts[wpts.length - 2].mentions, day: new Date(wpts[wpts.length - 1].t).toISOString().slice(0, 10) } : null;
    const redditUp = AT_LEAST_RISING.includes(scores.short.label);
    const wikiUp = Boolean(wikiScores) && AT_LEAST_RISING.includes(wikiScores.short.label);
    return {
      ...r,
      dayOverDay: dayOverDay(r),
      spark: merged.slice(-48).map((p) => p.mentions), // about the last 24 hours
      price: priceSummary(prices.get(r.ticker)),
      results: dueOf.get(r.ticker) || null,
      bigMove: bigMove && bigMove.scores[r.ticker] !== undefined ? { p: bigMove.scores[r.ticker], base: bigMove.base, asOf: bigMove.asOf, days: bigMove.H, auc: bigMove.auc } : null,
      scores,
      wiki: m ? { article: m.article, status: m.status, confidence: m.confidence, source: m.source, scores: wikiScores, views } : { article: null, status: 'pending', confidence: 'none', source: 'auto', scores: null },
      // both signals agree when Reddit and Wikipedia are each at Rising or above (short horizon)
      agreement: redditUp && wikiUp ? 'both' : redditUp ? 'reddit' : wikiUp ? 'wiki' : 'none',
    };
  });
  cache = { key: run, value };
  return value;
}

module.exports = { scoredStocks, listStocks, mergeSeries, priceSummary, dayOverDay, ALL_SQL };
