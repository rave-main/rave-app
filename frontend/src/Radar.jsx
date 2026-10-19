import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Sparkline from './Sparkline.jsx';
import { Explain, dateTime, num, pct, signedPct, times, unusual, usd, usePoll, useStatus, useTick } from './lib.jsx';

const ORDER = { Extreme: 3, Hot: 2, Rising: 1, Quiet: 0 }; // anything else (Warming up, No data) sorts below Quiet
const HORIZONS = [['short', 'Last 24 hours'], ['medium', 'Last 7 days'], ['long', 'Last 4 weeks']];
const LABELS = ['Extreme', 'Hot', 'Rising', 'Quiet', 'Low volume', 'Warming up'];

// Starred stocks live in this browser only
function useStars() {
  const read = () => { try { return JSON.parse(localStorage.getItem('rave-stars') || '[]'); } catch { return []; } };
  const [stars, setStars] = useState(read);
  const toggle = useCallback((t) => setStars((cur) => {
    const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
    try { localStorage.setItem('rave-stars', JSON.stringify(next)); } catch { /* private mode: stars last for this visit only */ }
    return next;
  }), []);
  return [stars, toggle];
}

export const LabelChip = ({ label }) => <span className={`chip ${label.toLowerCase().replace(' ', '-')}`}>{label}</span>;

const sortValue = {
  ticker: (r) => r.ticker,
  label: (r, h) => ORDER[r.scores[h].label] ?? -1,
  mentions: (r) => r.mentions,
  dod: (r) => r.dayOverDay?.ratio ?? -1,
  wikiviews: (r) => r.wiki?.views?.now ?? -1,
  wikichg: (r) => (r.wiki?.views && r.wiki.views.before > 0 ? r.wiki.views.now / r.wiki.views.before : -1),
  ratio: (r, h) => r.scores[h].adjusted?.ratio ?? r.scores[h].raw?.ratio ?? -1,
  rank: (r) => (r.ranked ? -r.rank : -Infinity), // a better (smaller) rank sorts higher
  wiki: (r, h) => ORDER[r.wiki?.scores?.[h]?.label] ?? -1,
  price: (r) => r.price?.close ?? -1,
  week: (r) => r.price?.change1w ?? -Infinity,
  swing: (r) => r.price?.swing20 ?? -Infinity,
};

const change = (now, before) => {
  if (now === null || now === undefined || before === null || before === undefined) return null;
  const d = now - before;
  return { d, p: before > 0 ? d / before : null };
};
const Change = ({ c }) => (c ? <small className={c.d > 0 ? 'up' : c.d < 0 ? 'down' : ''}> {c.d > 0 ? '+' : c.d < 0 ? '−' : ''}{num(Math.abs(c.d))}{c.p === null ? ' new' : ` (${c.p > 0 ? '+' : c.p < 0 ? '−' : ''}${Math.round(Math.abs(c.p) * 100)}%)`}</small> : null);

// One cell per source: label, the measure now, and the change since the comparison point, e.g. "Hot 60 −10 (−14%)"
function RedditCell({ r, horizon }) {
  const s = r.scores[horizon];
  const c = r.dayOverDay ? change(r.mentions, r.mentions24hAgo) : null;
  return (
    <span className="src-cell" title={`Reddit: ${s.explanation}`}>
      <LabelChip label={s.label} />{s.unconfirmed && <small title="Waiting for the next reading to confirm"> unconfirmed</small>}
      {r.fetchedAt && <strong className="measure">{r.ranked ? num(r.mentions) : 0}</strong>}<Change c={c} />
    </span>
  );
}

function WikiCell({ r, horizon }) {
  const w = r.wiki;
  if (!w || !w.article) {
    return <span className="muted" title={w?.status === 'pending' ? 'Still looking for this company\'s Wikipedia page' : 'No Wikipedia page found (you can set one in Settings)'}>{w?.status === 'pending' ? '…' : 'none'}</span>;
  }
  const s = w.scores?.[horizon];
  if (!s) return <span className="muted">…</span>;
  const c = w.views ? change(w.views.now, w.views.before) : null;
  return (
    <span className="src-cell" title={`${w.article}: ${s.explanation}`}>
      <LabelChip label={s.label} />{w.views && <strong className="measure">{num(w.views.now)}</strong>}<Change c={c} />
    </span>
  );
}

// For rank, a smaller number is better: ▲ green = moved up the leaderboard, ▼ red = moved down
function RankMove({ now, before }) {
  if (before === null || before === undefined || now === null || now === undefined || now === before) return null;
  const up = now < before;
  return <span className={`delta ${up ? 'good' : 'bad'}`} title={`was #${before} a day ago`}>{up ? '▲' : '▼'}</span>;
}

export default function Radar() {
  useTick(15000);
  const { data: stocks, error } = usePoll('/rave/stocks', 60000);
  const { status } = useStatus();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [shown, setShown] = useState(100);
  const [stars, toggleStar] = useStars();

  const horizon = params.get('h') || 'short';
  const redditFilter = params.get('rl') || 'all';
  const wikiFilter = params.get('wl') || 'all';
  const kindFilter = params.get('kind') || 'all';
  const starredOnly = params.get('starred') === '1';
  const q = params.get('q') || '';
  const sort = params.get('sort') || 'label';
  const dir = params.get('dir') || 'desc';
  const set = (patch) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v === null || v === '' || v === 'all' ? next.delete(k) : next.set(k, v)));
    setParams(next, { replace: true });
    setShown(100);
  };

  const rows = useMemo(() => {
    if (!stocks) return [];
    const needle = q.trim().toLowerCase();
    const list = stocks.filter((r) =>
      (kindFilter === 'all' || (kindFilter === 'company' ? r.kind !== 'etf' : r.kind === 'etf')) &&
      (!starredOnly || stars.includes(r.ticker)) &&
      (redditFilter === 'all' || r.scores[horizon].label === redditFilter) &&
      (wikiFilter === 'all' || (r.wiki?.scores?.[horizon]?.label ?? 'No page') === wikiFilter) &&
      (!needle || r.tickers.some((t) => t.toLowerCase().includes(needle)) || r.name.toLowerCase().includes(needle))
    );
    const val = sortValue[sort] || sortValue.label;
    return list.sort((a, b) => {
      const [x, y] = [val(a, horizon), val(b, horizon)];
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return (dir === 'asc' ? c : -c) || b.mentions - a.mentions;
    });
  }, [stocks, horizon, redditFilter, wikiFilter, kindFilter, starredOnly, stars, q, sort, dir]);

  const counts = useMemo(() => {
    const red = {}, wik = {};
    for (const r of stocks || []) {
      const a = r.scores[horizon].label; red[a] = (red[a] || 0) + 1;
      const b = r.wiki?.scores?.[horizon]?.label ?? 'No page'; wik[b] = (wik[b] || 0) + 1;
    }
    return { red, wik };
  }, [stocks, horizon]);

  const movers = useMemo(() => (stocks || [])
    .filter((r) => r.dayOverDay && Math.max(r.mentions, r.mentions24hAgo) >= 5)
    .sort((a, b) => Math.abs(b.dayOverDay.change) - Math.abs(a.dayOverDay.change))
    .slice(0, 3), [stocks]);

  const context = useMemo(() => {
    const ratios = (stocks || []).map((r) => r.scores.short.market?.ratio).filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
    return ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
  }, [stocks]);
  const top = useMemo(() => [...(stocks || [])].sort((a, b) => b.mentions - a.mentions).slice(0, 10), [stocks]);

  const sortBy = (key) => set(sort === key ? { dir: dir === 'desc' ? 'asc' : 'desc' } : { sort: key, dir: key === 'ticker' ? 'asc' : 'desc' });
  const th = (key, text, cls = '', hint) => (
    <th className={`sortable ${cls}`} title={hint} onClick={() => sortBy(key)} aria-sort={sort === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {text}{sort === key && <span className="sort-ind">{dir === 'asc' ? ' ↑' : ' ↓'}</span>}
    </th>
  );

  if (error && !stocks) return <p className="banner err">Could not load stocks — {error.message}</p>;
  if (!stocks) return <p className="muted">Loading…</p>;

  const warming = stocks.every((r) => r.scores[horizon].status !== 'ok');
  const since = status?.history?.firstSnapshotAt;
  const horizonName = HORIZONS.find(([k]) => k === horizon)[1].toLowerCase();

  return (
    <>
      <p className="lede">
        RAVE watches how much small investors are talking about every stock on Reddit, and how many people look up the company on Wikipedia.
        A sudden jump in attention is flagged, because attention can come before big moves in a share price.
      </p>
      <Explain title="How to read this page">
        <ul>
          <li>Each cell reads like <strong>Hot 60 −10 (−14%)</strong>: the rating, then the count now (Reddit: mentions in the last 24 hours; Wikipedia: page views on the latest full day), then the change since 24 hours (Reddit) or a day (Wikipedia) earlier.</li>
          <li><strong>Times normal</strong> compares attention with what is usual for that stock. 1× is normal, 3× is three times as much.</li>
          <li><strong>Rising, Hot, Extreme</strong> mean attention is unusually high (Extreme is the most). <strong>Quiet</strong> means normal. <strong>Low volume</strong> means the stock is rarely mentioned, so a jump could be chance and it is not rated.</li>
          <li><strong>Wikipedia</strong> is the same idea using daily views of the company's Wikipedia page. It is about a day behind. <span className="both">●●</span> means Reddit and Wikipedia both show a jump.</li>
          <li>Prices are in US dollars. This is research, not investment advice.</li>
        </ul>
      </Explain>

      {context !== null && (
        <p className="context">Reddit stock chatter overall is <strong>{times(context)}</strong> its usual level{context >= 1.3 ? ' (busier than normal)' : context <= 0.75 ? ' (quieter than normal)' : ' (about normal)'}.</p>
      )}
      <section className="top10" aria-label="Most talked about right now">
        <h2>Most talked about right now <small>Reddit mentions in the last 24 hours</small></h2>
        <div className="mover-row">
          {top.map((r) => (
            <Link key={r.ticker} to={`/stock/${r.ticker}`} className="mover" title={r.name}>
              <strong>{r.label}</strong><small>{num(r.mentions)} mentions</small><LabelChip label={r.scores[horizon].label} />
            </Link>
          ))}
        </div>
      </section>

      {movers.length > 0 && (
        <section className="movers" aria-label="Biggest changes in mentions since yesterday">
          <h2>Biggest changes <small>Reddit mentions now compared with 24 hours ago</small></h2>
          <div className="mover-row">
            {movers.map((r) => (
              <Link key={r.ticker} to={`/stock/${r.ticker}`} className="mover">
                <strong>{r.label}</strong>
                <span className={r.dayOverDay.change >= 0 ? 'up' : 'down'}>{r.dayOverDay.change >= 0 ? '▲' : '▼'} {Math.abs(r.dayOverDay.change)}</span>
                <small>{num(r.mentions24hAgo)} → {num(r.mentions)} mentions</small>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <div className="toolbar">
          <div className="seg" role="tablist" aria-label="Time window">
            {HORIZONS.map(([k, text]) => (
              <button key={k} role="tab" aria-selected={horizon === k} className={horizon === k ? 'on' : ''} onClick={() => set({ h: k === 'short' ? null : k })}>{text}</button>
            ))}
          </div>
          <label className="filter">Show
            <select value={kindFilter} onChange={(e) => set({ kind: e.target.value })} aria-label="Companies or funds">
              <option value="all">All</option><option value="company">Companies</option><option value="etf">Funds (ETFs)</option>
            </select>
          </label>
          <button type="button" className={`star-filter ${starredOnly ? 'on' : ''}`} onClick={() => set({ starred: starredOnly ? null : '1' })} aria-pressed={starredOnly}>★ Starred ({stars.length})</button>
          <label className="filter">Reddit
            <select value={redditFilter} onChange={(e) => set({ rl: e.target.value })} aria-label="Show only stocks with this Reddit label">
              <option value="all">Any ({stocks.length})</option>
              {LABELS.map((l) => <option key={l} value={l}>{l} ({counts.red[l] || 0})</option>)}
            </select>
          </label>
          <label className="filter">Wikipedia
            <select value={wikiFilter} onChange={(e) => set({ wl: e.target.value })} aria-label="Show only stocks with this Wikipedia label">
              <option value="all">Any ({stocks.length})</option>
              {[...LABELS, 'No page'].map((l) => <option key={l} value={l}>{l} ({counts.wik[l] || 0})</option>)}
            </select>
          </label>
          <label className="filter">Sort by
            <select value={`${sort}`} onChange={(e) => set({ sort: e.target.value, dir: e.target.value === 'ticker' ? 'asc' : 'desc' })} aria-label="Sort the table by">
              <option value="label">Reddit rating</option><option value="mentions">Reddit mentions</option><option value="dod">Reddit change %</option>
              <option value="wiki">Wikipedia rating</option><option value="wikiviews">Wikipedia views</option><option value="wikichg">Wikipedia change %</option>
              <option value="ratio">Times normal</option><option value="price">Price</option><option value="week">5-day price change</option><option value="rank">Reddit rank</option><option value="ticker">Ticker A to Z</option>
            </select>
          </label>
          <input className="search" type="search" placeholder="Search ticker or name" value={q} onChange={(e) => set({ q: e.target.value })} />
        </div>

        {warming && (
          <p className="banner info">
            RAVE is still collecting history{since ? <> (since {dateTime(since)})</> : ''}.
            The <strong>{horizonName}</strong> rating needs {horizon === 'short' ? 'about 3 days' : horizon === 'medium' ? 'about 5 weeks' : 'about 8 weeks'} of data. Until then, the number and change in each cell
            come straight from the source (ApeWisdom for Reddit).
          </p>
        )}

        <div className="table-wrap">
          <table className="radar">
            <thead>
              <tr>
                {th('ticker', 'Stock', '', 'Stock ticker. Hover a ticker for the company name')}
                {th('label', <>Reddit<small className="sub">rating · mentions 24h · change</small></>, '', `Rating over the ${horizonName}, then the number of Reddit mentions in the last 24 hours and the change since 24 hours ago`)}
                {th('wiki', <>Wikipedia<small className="sub">rating · views a day · change</small></>, '', `Rating over the ${horizonName}, then Wikipedia page views on the latest full day and the change since the day before`)}
                {th('ratio', 'Times normal', 'num hide-sm', "Reddit attention compared with this stock's own usual level (1× = normal)")}
                {th('price', 'Price (US$)', 'num', 'Latest closing price in US dollars')}
                {th('week', '5-day change', 'num hide-sm', 'Change in the share price over the last 5 trading days')}
                {th('swing', 'Typical 20-day swing', 'num hide-sm', 'How far this price typically moves up or down over 20 trading days (one standard deviation, from the last 60 trading days). A risk measure, not a prediction of direction')}
                {th('rank', 'Reddit rank', 'num hide-sm', 'Position on the Reddit leaderboard (1 = most mentioned)')}
                <th className="hide-sm" title="Mentions through the last 24 hours">Last 24 hours</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((r) => {
                const s = r.scores[horizon];
                const m = s.adjusted || s.raw;
                const chg = r.price?.change1w;
                return (
                  <tr key={r.ticker} onClick={() => navigate(`/stock/${r.ticker}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(`/stock/${r.ticker}`)}>
                    <td><button type="button" className={`star ${stars.includes(r.ticker) ? 'on' : ''}`} aria-label={`${stars.includes(r.ticker) ? 'Unstar' : 'Star'} ${r.label}`} onClick={(e) => { e.stopPropagation(); toggleStar(r.ticker); }}>{stars.includes(r.ticker) ? '★' : '☆'}</button><Link to={`/stock/${r.ticker}`} onClick={(e) => e.stopPropagation()} className="tk" title={r.name}><strong>{r.label}</strong></Link>{r.results && r.results.inDays <= 14 && <small className="results" title={`Company results are expected on ${r.results.day}: big price moves are common around results`}> results {r.results.inDays === 0 ? 'today' : `in ${r.results.inDays}d`}</small>}{r.kind === 'etf' && <small className="kind" title="A fund, not a single company"> fund</small>}{r.kind === 'ambiguous' && <small className="kind" title="This ticker is also an ordinary word, so some mentions may not be about the stock"> ⚠</small>}</td>
                    <td><RedditCell r={r} horizon={horizon} />{horizon === 'short' && r.agreement === 'both' && <span className="both" title="Reddit AND Wikipedia both show a jump">●●</span>}</td>
                    <td><WikiCell r={r} horizon={horizon} /></td>
                    <td className="num hide-sm" title={s.explanation}>{s.label === 'Low volume' ? <span className="muted" title="Too few mentions to rate">—</span> : m ? <>{times(m.ratio)}</> : <span className="muted">warming up</span>}</td>
                    <td className="num">{r.price ? usd(r.price.close) : <span className="muted">—</span>}</td>
                    <td className={`num hide-sm ${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}`}>{r.price ? <>{signedPct(chg)}{r.price.ran && <small className="ran" title="The price already moved far more than usual over 5 days, so much of any move may be over"> ran</small>}</> : <span className="muted">—</span>}</td>
                    <td className="num hide-sm" title="Typical size of a 20-trading-day price move (up or down) for this stock, from the last 60 trading days">{r.price?.swing20 != null ? `±${(r.price.swing20 * 100).toFixed(0)}%` : <span className="muted">—</span>}</td>
                    <td className="num hide-sm">{r.ranked ? <>#{r.rank} <RankMove now={r.rank} before={r.rank24hAgo} /></> : <span className="muted">—</span>}</td>
                    <td className="hide-sm"><Sparkline values={r.spark} /></td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan="9" className="muted center">No stocks match these filters.</td></tr>}
            </tbody>
          </table>
        </div>
        {rows.length > shown && <p className="center"><button type="button" onClick={() => setShown(shown + 200)}>Show more ({rows.length - shown} more)</button></p>}
        <p className="count muted">{rows.length === stocks.length ? `All ${stocks.length} stocks on the Reddit leaderboard` : `${rows.length} of ${stocks.length} stocks`}. Companies with more than one kind of share (for example GOOGL / GOOG) are shown once, with their mentions added together.</p>
      </section>
    </>
  );
}
