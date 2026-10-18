import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Sparkline from './Sparkline.jsx';
import { Explain, dateTime, num, pct, signedPct, times, unusual, usd, usePoll, useStatus, useTick } from './lib.jsx';

const ORDER = { Extreme: 3, Hot: 2, Rising: 1, Quiet: 0 }; // anything else (Warming up, No data) sorts below Quiet
const HORIZONS = [['short', 'Last 24 hours'], ['medium', 'Last 7 days'], ['long', 'Last 4 weeks']];
const LABELS = ['Extreme', 'Hot', 'Rising', 'Quiet', 'Low volume', 'Warming up'];

export const LabelChip = ({ label }) => <span className={`chip ${label.toLowerCase().replace(' ', '-')}`}>{label}</span>;

const sortValue = {
  ticker: (r) => r.ticker,
  label: (r, h) => ORDER[r.scores[h].label] ?? -1,
  mentions: (r) => r.mentions,
  dod: (r) => r.dayOverDay?.ratio ?? -1,
  ratio: (r, h) => r.scores[h].adjusted?.ratio ?? r.scores[h].raw?.ratio ?? -1,
  rank: (r) => (r.ranked ? -r.rank : -Infinity), // a better (smaller) rank sorts higher
  wiki: (r, h) => ORDER[r.wiki?.scores?.[h]?.label] ?? -1,
  price: (r) => r.price?.close ?? -1,
  week: (r) => r.price?.change1w ?? -Infinity,
};

// Wikipedia page-view signal for one stock at the chosen horizon
function WikiCell({ r, horizon }) {
  const w = r.wiki;
  if (!w || !w.article) {
    return <span className="muted" title={w?.status === 'pending' ? 'Still looking for this company\'s Wikipedia article' : 'No Wikipedia article found (you can set one in Settings)'}>{w?.status === 'pending' ? '…' : 'none'}</span>;
  }
  const s = w.scores?.[horizon];
  if (!s) return <span className="muted">…</span>;
  const m = s.adjusted || s.raw;
  return (
    <span title={`${w.article}: ${s.explanation}`}>
      <LabelChip label={s.label} />{m && s.status === 'ok' && s.label !== 'Quiet' && s.label !== 'Low volume' ? <small> {times(m.ratio)}</small> : null}
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

  const horizon = params.get('h') || 'short';
  const labelFilter = params.get('label') || 'all';
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
      (labelFilter === 'all' || r.scores[horizon].label === labelFilter) &&
      (!needle || r.tickers.some((t) => t.toLowerCase().includes(needle)) || r.name.toLowerCase().includes(needle))
    );
    const val = sortValue[sort] || sortValue.label;
    return list.sort((a, b) => {
      const [x, y] = [val(a, horizon), val(b, horizon)];
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return (dir === 'asc' ? c : -c) || b.mentions - a.mentions;
    });
  }, [stocks, horizon, labelFilter, q, sort, dir]);

  const movers = useMemo(() => (stocks || [])
    .filter((r) => r.dayOverDay && Math.max(r.mentions, r.mentions24hAgo) >= 5)
    .sort((a, b) => Math.abs(b.dayOverDay.change) - Math.abs(a.dayOverDay.change))
    .slice(0, 3), [stocks]);

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
          <li><strong>Mentions</strong> are the number of Reddit posts and comments that name the stock in the last 24 hours.</li>
          <li><strong>Times normal</strong> compares attention with what is usual for that stock. 1× is normal, 3× is three times as much.</li>
          <li><strong>Rising, Hot, Extreme</strong> mean attention is unusually high (Extreme is the most). <strong>Quiet</strong> means normal. <strong>Low volume</strong> means the stock is rarely mentioned, so a jump could be chance and it is not rated.</li>
          <li><strong>Wikipedia</strong> is the same idea using daily views of the company's Wikipedia page. It is about a day behind. <span className="both">●●</span> means Reddit and Wikipedia both show a jump.</li>
          <li>Prices are in US dollars. This is research, not investment advice.</li>
        </ul>
      </Explain>

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
          <select value={labelFilter} onChange={(e) => set({ label: e.target.value })} aria-label="Show only stocks with this label">
            <option value="all">Any label</option>
            {LABELS.map((l) => <option key={l}>{l}</option>)}
          </select>
          <input className="search" type="search" placeholder="Search ticker or name" value={q} onChange={(e) => set({ q: e.target.value })} />
        </div>

        {warming && (
          <p className="banner info">
            RAVE is still collecting history{since ? <> (since {dateTime(since)})</> : ''}.
            The <strong>{horizonName}</strong> rating needs {horizon === 'short' ? 'about 3 days' : horizon === 'medium' ? 'about 5 weeks' : 'about 8 weeks'} of data. Until then, use the
            <em> Mentions</em> and <em>Change</em> columns, which come straight from the source (ApeWisdom).
          </p>
        )}

        <div className="table-wrap">
          <table className="radar">
            <thead>
              <tr>
                {th('ticker', 'Stock', '', 'Stock ticker. Hover a ticker for the company name')}
                {th('label', 'Reddit', '', `How unusual Reddit attention is, over the ${horizonName}`)}
                {th('wiki', 'Wikipedia', '', `How unusual Wikipedia page views are, over the ${horizonName}`)}
                {th('mentions', 'Mentions', 'num', 'Reddit posts and comments naming the stock in the last 24 hours')}
                {th('dod', 'Change', 'num hide-sm', 'Mentions now compared with 24 hours ago')}
                {th('ratio', 'Times normal', 'num hide-sm', "Reddit attention compared with this stock's own usual level (1× = normal)")}
                {th('price', 'Price (US$)', 'num', 'Latest closing price in US dollars')}
                {th('week', '5-day change', 'num hide-sm', 'Change in the share price over the last 5 trading days')}
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
                    <td><Link to={`/stock/${r.ticker}`} onClick={(e) => e.stopPropagation()} className="tk" title={r.name}><strong>{r.label}</strong></Link></td>
                    <td><LabelChip label={s.label} />{s.unconfirmed && <small title="Waiting for the next reading to confirm"> unconfirmed</small>}{horizon === 'short' && r.agreement === 'both' && <span className="both" title="Reddit AND Wikipedia both show a jump">●●</span>}</td>
                    <td><WikiCell r={r} horizon={horizon} /></td>
                    <td className="num">{r.fetchedAt ? (r.ranked ? num(r.mentions) : <span className="muted" title="Not on the Reddit leaderboard">0</span>) : '—'}</td>
                    <td className="num hide-sm">{r.dayOverDay ? <>{r.dayOverDay.change > 0 ? '+' : ''}{r.dayOverDay.change}{r.dayOverDay.ratio ? <small> {pct(r.dayOverDay.ratio)}</small> : <small> new</small>}</> : '—'}</td>
                    <td className="num hide-sm" title={s.explanation}>{s.label === 'Low volume' ? <span className="muted" title="Too few mentions to rate">—</span> : m ? <>{times(m.ratio)}<small> {unusual(m.z)}</small></> : <span className="muted">warming up</span>}</td>
                    <td className="num">{r.price ? usd(r.price.close) : <span className="muted">—</span>}</td>
                    <td className={`num hide-sm ${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}`}>{r.price ? signedPct(chg) : <span className="muted">—</span>}</td>
                    <td className="num hide-sm">{r.ranked ? <>#{r.rank} <RankMove now={r.rank} before={r.rank24hAgo} /></> : <span className="muted">—</span>}</td>
                    <td className="hide-sm"><Sparkline values={r.spark} /></td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan="10" className="muted center">No stocks match these filters.</td></tr>}
            </tbody>
          </table>
        </div>
        {rows.length > shown && <p className="center"><button type="button" onClick={() => setShown(shown + 200)}>Show more ({rows.length - shown} more)</button></p>}
        <p className="count muted">{rows.length === stocks.length ? `All ${stocks.length} stocks on the Reddit leaderboard` : `${rows.length} of ${stocks.length} stocks`}. Companies with more than one kind of share (for example GOOGL / GOOG) are shown once, with their mentions added together.</p>
      </section>
    </>
  );
}
