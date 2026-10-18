import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Sparkline from './Sparkline.jsx';
import { ago, dateTime, num, pct, times, unusual, usePoll, useStatus, useTick } from './lib.jsx';

const ORDER = { Extreme: 3, Hot: 2, Rising: 1, Quiet: 0 }; // anything else (Warming up, No data) sorts below Quiet
const HORIZONS = [['short', 'Short · 24h'], ['medium', 'Medium · 7d'], ['long', 'Long · 4w']];
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
};

// Wikipedia page-view signal for one stock at the chosen horizon
function WikiCell({ r, horizon }) {
  const w = r.wiki;
  if (!w || !w.article) {
    return <span className="muted" title={w?.status === 'pending' ? 'Looking for this company\'s Wikipedia article' : 'No Wikipedia article matched (fix it in Settings)'}>{w?.status === 'pending' ? '…' : 'no article'}</span>;
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
  const { status, now } = useStatus();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const horizon = params.get('h') || 'short';
  const group = params.get('group') || 'all';
  const labelFilter = params.get('label') || 'all';
  const q = params.get('q') || '';
  const sort = params.get('sort') || 'label';
  const dir = params.get('dir') || 'desc';
  const set = (patch) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v === null || v === '' || v === 'all' ? next.delete(k) : next.set(k, v)));
    setParams(next, { replace: true });
  };

  const rows = useMemo(() => {
    if (!stocks) return [];
    const needle = q.trim().toLowerCase();
    const list = stocks.filter((r) =>
      (group === 'all' || (group === 'controls' ? r.isControl : group === 'watchlist' ? r.isWatchlist && !r.isControl : !r.isWatchlist)) &&
      (labelFilter === 'all' || r.scores[horizon].label === labelFilter) &&
      (!needle || r.ticker.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle))
    );
    const val = sortValue[sort] || sortValue.label;
    return list.sort((a, b) => {
      const [x, y] = [val(a, horizon), val(b, horizon)];
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return (dir === 'asc' ? c : -c) || b.mentions - a.mentions;
    });
  }, [stocks, horizon, group, labelFilter, q, sort, dir]);

  const movers = useMemo(() => (stocks || [])
    .filter((r) => r.dayOverDay && Math.max(r.mentions, r.mentions24hAgo) >= 5)
    .sort((a, b) => Math.abs(b.dayOverDay.change) - Math.abs(a.dayOverDay.change))
    .slice(0, 3), [stocks]);

  const sortBy = (key) => set(sort === key ? { dir: dir === 'desc' ? 'asc' : 'desc' } : { sort: key, dir: key === 'ticker' ? 'asc' : 'desc' });
  const th = (key, text, cls = '') => (
    <th className={`sortable ${cls}`} onClick={() => sortBy(key)} aria-sort={sort === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {text}{sort === key && <span className="sort-ind">{dir === 'asc' ? ' ↑' : ' ↓'}</span>}
    </th>
  );

  if (error && !stocks) return <p className="banner err">Could not load stocks — {error.message}</p>;
  if (!stocks) return <p className="muted">Loading…</p>;

  const warming = stocks.every((r) => r.scores[horizon].status !== 'ok');
  const since = status?.history?.firstSnapshotAt;

  return (
    <>
      {movers.length > 0 && (
        <section className="movers" aria-label="Biggest moves versus 24 hours ago">
          <h2>Biggest moves <small>vs 24 hours ago, as reported by ApeWisdom</small></h2>
          <div className="mover-row">
            {movers.map((r) => (
              <Link key={r.ticker} to={`/stock/${r.ticker}`} className="mover">
                <strong>{r.ticker}</strong>
                <span className={r.dayOverDay.change >= 0 ? 'up' : 'down'}>{r.dayOverDay.change >= 0 ? '▲' : '▼'} {Math.abs(r.dayOverDay.change)}</span>
                <small>{num(r.mentions24hAgo)} → {num(r.mentions)} mentions</small>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <div className="toolbar">
          <div className="seg" role="tablist" aria-label="Horizon">
            {HORIZONS.map(([k, text]) => (
              <button key={k} role="tab" aria-selected={horizon === k} className={horizon === k ? 'on' : ''} onClick={() => set({ h: k === 'short' ? null : k })}>{text}</button>
            ))}
          </div>
          <div className="seg" aria-label="Group">
            {[['all', 'All'], ['watchlist', 'Watchlist'], ['controls', 'Controls'], ['other', 'Other']].map(([k, text]) => (
              <button key={k} className={group === k ? 'on' : ''} onClick={() => set({ group: k })}>{text}</button>
            ))}
          </div>
          <select value={labelFilter} onChange={(e) => set({ label: e.target.value })} aria-label="Filter by label">
            <option value="all">Any label</option>
            {LABELS.map((l) => <option key={l}>{l}</option>)}
          </select>
          <input className="search" type="search" placeholder="Search ticker or name" value={q} onChange={(e) => set({ q: e.target.value })} />
        </div>

        {warming && (
          <p className="banner info">
            RAVE is still collecting history{since ? <> (since {dateTime(since)}, {status.history.snapshots} snapshot{status.history.snapshots === 1 ? '' : 's'})</> : ''}.
            The <strong>{HORIZONS.find(([k]) => k === horizon)[1].split(' ·')[0].toLowerCase()}</strong> score needs {horizon === 'short' ? 'about 3 days' : horizon === 'medium' ? 'about 5 weeks' : 'about 8 weeks'} of data; until then use the
            <em> Mentions</em> and <em>vs 24h</em> columns, which come straight from ApeWisdom.
          </p>
        )}

        <div className="table-wrap">
          <table className="radar">
            <thead>
              <tr>
                {th('ticker', 'Stock')}
                {th('label', 'Reddit')}
                {th('wiki', 'Wikipedia')}
                {th('mentions', 'Mentions 24h', 'num')}
                {th('dod', 'vs 24h', 'num')}
                <th className="sortable num" onClick={() => sortBy('ratio')} title="Today compared with this stock's own usual level, adjusted for overall Reddit chatter" aria-sort={sort === 'ratio' ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>vs normal{sort === 'ratio' && <span className="sort-ind">{dir === 'asc' ? ' ↑' : ' ↓'}</span>}</th>
                {th('rank', 'Rank', 'num')}
                <th>Last 24h</th>
                <th className="num">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = r.scores[horizon];
                const m = s.adjusted || s.raw;
                return (
                  <tr key={r.ticker} onClick={() => navigate(`/stock/${r.ticker}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(`/stock/${r.ticker}`)}>
                    <td><Link to={`/stock/${r.ticker}`} onClick={(e) => e.stopPropagation()} className="tk"><strong>{r.ticker}</strong></Link><small>{r.name}{r.isControl ? ' · control' : ''}</small></td>
                    <td><LabelChip label={s.label} />{s.unconfirmed && <small title="Waiting for the next snapshot to confirm"> unconfirmed</small>}{horizon === 'short' && r.agreement === 'both' && <span className="both" title="Reddit AND Wikipedia both show a spike">●●</span>}</td>
                    <td><WikiCell r={r} horizon={horizon} /></td>
                    <td className="num">{r.fetchedAt ? (r.ranked ? num(r.mentions) : <span className="muted" title="Not on the ApeWisdom leaderboard">0</span>) : '—'}</td>
                    <td className="num">{r.dayOverDay ? <>{r.dayOverDay.change > 0 ? '+' : ''}{r.dayOverDay.change}{r.dayOverDay.ratio ? <small> {pct(r.dayOverDay.ratio)}</small> : <small> new</small>}</> : '—'}</td>
                    <td className="num" title={s.explanation}>{s.label === 'Low volume' ? <span className="muted" title="Too few mentions to rate">—</span> : m ? <>{times(m.ratio)}<small> {unusual(m.z)}</small></> : <span className="muted">warming up</span>}</td>
                    <td className="num">{r.ranked ? <>#{r.rank} <RankMove now={r.rank} before={r.rank24hAgo} /></> : <span className="muted">—</span>}</td>
                    <td><Sparkline values={r.spark} /></td>
                    <td className="num"><small>{r.fetchedAt ? ago(now() - new Date(r.fetchedAt).getTime()) : '—'}</small></td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan="9" className="muted center">No stocks match these filters.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="count muted">{rows.length} of {stocks.length} tracked stocks (the watchlist plus every stock that reached 5 Reddit mentions a day this week). All ~800 leaderboard stocks are stored.</p>
        <p className="foot">
          <strong>Reddit</strong> and <strong>Wikipedia</strong> are two independent signals: Reddit mentions (ApeWisdom) and daily views of the company's Wikipedia article. <span className="both">●●</span> means both show a spike.
          <strong> Mentions 24h</strong>: Reddit posts and comments mentioning the ticker in the last 24 hours (ApeWisdom). <strong>vs 24h</strong>: change from a day ago.
          <strong> vs normal</strong>: today against this stock’s own usual level, adjusted for overall Reddit chatter (hover a value for the full reasoning).
          <strong> Low volume</strong>: typically fewer than 5 mentions a day, too few to separate a real change from chance, so it is not rated.
        </p>
      </section>
    </>
  );
}
