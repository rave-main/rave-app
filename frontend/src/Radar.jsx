import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Sparkline from './Sparkline.jsx';
import { ago, dateTime, num, times, usePoll, useStatus, useTick } from './lib.jsx';

const ORDER = { Extreme: 3, Hot: 2, Rising: 1, Quiet: 0 }; // anything else (Warming up, No data) sorts below Quiet
const HORIZONS = [['short', 'Short · 24h'], ['medium', 'Medium · 7d'], ['long', 'Long · 4w']];
const LABELS = ['Extreme', 'Hot', 'Rising', 'Quiet', 'Warming up'];

export const LabelChip = ({ label }) => <span className={`chip ${label.toLowerCase().replace(' ', '-')}`}>{label}</span>;

const sortValue = {
  ticker: (r) => r.ticker,
  label: (r, h) => ORDER[r.scores[h].label] ?? -1,
  mentions: (r) => r.mentions,
  dod: (r) => r.dayOverDay?.ratio ?? -1,
  ratio: (r, h) => r.scores[h].adjusted?.ratio ?? r.scores[h].raw?.ratio ?? -1,
  rank: (r) => (r.ranked ? -r.rank : -Infinity), // a better (smaller) rank sorts higher
};

function Arrow({ now, before, better = 'up' }) {
  if (before === null || before === undefined || now === null || now === undefined || now === before) return null;
  const up = now > before;
  const good = better === 'up' ? up : !up;
  return <span className={`delta ${good ? 'good' : 'bad'}`}>{up ? '▲' : '▼'}</span>;
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
      (group === 'all' || (group === 'controls' ? r.isControl : !r.isControl)) &&
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
            {[['all', 'All'], ['hype', 'Hype'], ['controls', 'Controls']].map(([k, text]) => (
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
                {th('label', 'Signal')}
                {th('mentions', 'Mentions 24h', 'num')}
                {th('dod', 'vs 24h', 'num')}
                {th('ratio', 'vs normal', 'num')}
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
                    <td><LabelChip label={s.label} />{s.unconfirmed && <small title="Waiting for the next snapshot to confirm"> unconfirmed</small>}</td>
                    <td className="num">{r.fetchedAt ? (r.ranked ? num(r.mentions) : <span className="muted" title="Not on the ApeWisdom leaderboard">0</span>) : '—'}</td>
                    <td className="num">{r.dayOverDay ? <>{r.dayOverDay.change > 0 ? '+' : ''}{r.dayOverDay.change}{r.dayOverDay.ratio ? <small> {times(r.dayOverDay.ratio)}</small> : null}</> : '—'}</td>
                    <td className="num" title={s.explanation}>{m ? <>{times(m.ratio)}<small> z {m.z.toFixed(1)}</small></> : <span className="muted">warming up</span>}</td>
                    <td className="num">{r.ranked ? <>#{r.rank} <Arrow now={r.rank} before={r.rank24hAgo} better="down" /></> : <span className="muted">—</span>}</td>
                    <td><Sparkline values={r.spark} /></td>
                    <td className="num"><small>{r.fetchedAt ? ago(now() - new Date(r.fetchedAt).getTime()) : '—'}</small></td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan="8" className="muted center">No stocks match these filters.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="foot">Mentions are Reddit stock mentions in the last 24 hours (ApeWisdom). “vs normal” compares with the stock’s own history; hover it for the reasoning.</p>
      </section>
    </>
  );
}
