import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { freshness } from './Freshness.jsx';
import { ago, clock, dateTime, num, usePoll, useStatus, useTick } from './lib.jsx';

const Stat = ({ title, value, sub, tone }) => (
  <div className={`stat ${tone || ''}`}>
    <span className="stat-title">{title}</span>
    <strong>{value}</strong>
    <small>{sub}</small>
  </div>
);

export default function DataHealth() {
  useTick(15000);
  const { status, error, now } = useStatus();
  const { data: runs } = usePoll('/rave/runs?limit=40', 30000);
  if (error && !status) return <p className="banner err">Could not load status — {error.message}</p>;
  if (!status) return <p className="muted">Loading…</p>;

  const f = freshness(status, now);
  const ok = status.lastSuccess;
  const chart = [...(runs || [])].reverse().map((r) => ({
    id: r.id, time: clock(r.startedAt), total: r.status === 'success' ? r.marketTotalMentions : 0, state: r.status !== 'success' ? 'failed' : r.changed === false ? 'same' : 'changed',
  }));
  const colour = { changed: 'var(--accent)', same: 'var(--muted)', failed: 'var(--err)' };

  return (
    <>
      <section className="stats">
        <Stat
          title="Collector"
          value={f.level === 'live' ? 'Live' : f.level === 'delayed' ? 'Delayed' : f.level === 'stale' ? 'Stale' : 'Waiting'}
          tone={f.level}
          sub={ok ? `Last check ${clock(ok.startedAt)} (${ago(f.checkedMs)})${f.nextMin > 0 ? ` · next in ~${Math.ceil(f.nextMin)} min` : ' · next check is due'}` : 'No successful run yet'}
        />
        <Stat
          title="ApeWisdom data last changed"
          value={status.lastChangeAt ? ago(f.changedMs) : ok ? 'Not yet' : '—'}
          sub={status.unchangedRuns ? `${status.unchangedRuns} check${status.unchangedRuns === 1 ? '' : 's'} since with identical numbers` : status.lastChangeAt ? 'Numbers changed at the latest check' : 'Needs at least two checks to compare'}
        />
        <Stat
          title="History collected"
          value={`${num(status.history.snapshots)} snapshot${status.history.snapshots === 1 ? '' : 's'}`}
          sub={status.history.firstSnapshotAt ? `since ${dateTime(status.history.firstSnapshotAt)}` : 'nothing stored yet'}
        />
        <Stat
          title="Last 24 hours"
          value={`${status.last24h.success} ok · ${status.last24h.failed} failed`}
          tone={status.last24h.failed ? 'delayed' : ''}
          sub={ok ? `${num(ok.tickersSeen)} tickers · ${ok.pagesFetched}/${ok.pagesTotal} pages · ${num(ok.marketTotalMentions)} mentions in total` : ''}
        />
      </section>

      {status.lastRun?.status === 'failed' && (
        <p className="banner err">Latest run failed: {status.lastRun.error}. RAVE keeps the previous data and retries at the next check.</p>
      )}

      <section className="card">
        <h2>Collection runs <small>each bar is one check; height = total mentions on the whole leaderboard</small></h2>
        <div className="legend"><i style={{ background: colour.changed }} /> data changed <i style={{ background: colour.same }} /> same numbers as before <i style={{ background: colour.failed }} /> failed</div>
        <div className="chart-box">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chart} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="time" stroke="var(--muted)" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={24} />
              <YAxis stroke="var(--muted)" tick={{ fontSize: 11 }} />
              <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8 }} labelStyle={{ color: 'var(--text)' }} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <Bar dataKey="total" name="Mentions (all tickers)" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {chart.map((c) => <Cell key={c.id} fill={colour[c.state]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="table-wrap">
          <table className="runs">
            <thead><tr><th>Checked</th><th>Result</th><th>Data changed</th><th className="num">Tickers</th><th className="num">Pages</th><th className="num">Rows saved</th><th className="num">Took</th></tr></thead>
            <tbody>
              {(runs || []).slice(0, 15).map((r) => (
                <tr key={r.id}>
                  <td>{dateTime(r.startedAt)}</td>
                  <td><span className={`chip ${r.status === 'success' ? 'ok' : 'failed'}`}>{r.status}</span>{r.error && <small className="err-text"> {r.error}</small>}</td>
                  <td>{r.changed === null ? <span className="muted">—</span> : r.changed ? 'Yes' : <span className="muted">No</span>}</td>
                  <td className="num">{num(r.tickersSeen)}</td>
                  <td className="num">{r.pagesFetched ?? '—'}/{r.pagesTotal ?? '—'}</td>
                  <td className="num">{num(r.rowsWritten)}</td>
                  <td className="num">{r.durationSec === null ? '—' : `${r.durationSec.toFixed(1)}s`}</td>
                </tr>
              ))}
              {runs && !runs.length && <tr><td colSpan="7" className="muted center">No runs yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="foot">
          RAVE asks ApeWisdom for the whole leaderboard about every 30 minutes. “Checked” means RAVE fetched and saved a snapshot; “data changed”
          means at least one stored mention count differs from the previous snapshot. If checks keep succeeding but the numbers do not change,
          the source is updating slowly, not RAVE.
        </p>
      </section>
    </>
  );
}
