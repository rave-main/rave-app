import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { freshness } from './Freshness.jsx';
import { useState } from 'react';
import { api } from './api.js';
import { ago, clock, dateTime, num, usePoll, useStatus, useTick } from './lib.jsx';

const Stat = ({ title, value, sub, tone }) => (
  <div className={`stat ${tone || ''}`}>
    <span className="stat-title">{title}</span>
    <strong>{value}</strong>
    <small>{sub}</small>
  </div>
);

function Sources() {
  const { data, reload } = usePoll('/rave/sources', 60000);
  const [busy, setBusy] = useState('');
  if (!data) return null;
  async function run(kind) {
    setBusy(kind);
    try { await api(`/rave/jobs/${kind}/run`, { method: 'POST' }); } catch { /* shown by status below */ }
    setTimeout(() => { setBusy(''); reload(); }, 4000);
  }
  return (
    <section className="card">
      <h2>Data sources <small>each runs on a fixed schedule and catches up after any restart</small></h2>
      <div className="table-wrap">
        <table className="runs">
          <thead><tr><th>Source</th><th>Schedule</th><th>Last success</th><th>Next</th><th>State</th><th /></tr></thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.kind}>
                <td>{s.label}</td>
                <td><small>{s.cadence}</small></td>
                <td>{s.lastSuccess ? dateTime(s.lastSuccess.startedAt) : <span className="muted">never</span>}</td>
                <td>{s.nextScheduledAt ? dateTime(s.nextScheduledAt) : '—'}</td>
                <td>
                  <span className={`chip ${s.stale ? 'failed' : 'ok'}`}>{s.stale ? 'stale' : 'fresh'}</span>
                  {s.lastRun?.status === 'failed' && <small className="err-text"> {s.lastRun.error}</small>}
                </td>
                <td><button type="button" disabled={busy === s.kind} onClick={() => run(s.kind)}>{busy === s.kind ? 'Started…' : 'Run now'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function DataHealth() {
  useTick(15000);
  const { status, error, now } = useStatus();
  const { data: runs } = usePoll('/rave/runs?limit=40', 30000);
  const { data: audit } = usePoll('/rave/integrity?runs=48', 300000);
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
          title="Database"
          value={`${num(status.database.sizeMB)} MB`}
          tone={status.database.usedPercent >= 80 ? 'stale' : status.database.usedPercent >= 60 ? 'delayed' : ''}
          sub={`${status.database.usedPercent}% of the ${num(status.database.limitMB)} MB volume`}
        />
        <Stat
          title="Last 24 hours"
          value={`${status.last24h.success} ok · ${status.last24h.failed} failed`}
          tone={status.last24h.failed ? 'delayed' : ''}
          sub={ok ? `${num(ok.tickersSeen)} tickers · ${ok.pagesFetched}/${ok.pagesTotal} pages · ${num(ok.marketTotalMentions)} mentions in total` : ''}
        />
      </section>

      <Sources />

      {status.lastRun?.status === 'failed' && (
        <p className="banner err">Latest run failed: {status.lastRun.error}. RAVE keeps the previous data and retries at the next check.</p>
      )}

      {audit && (
        <section className={`card integrity ${audit.ok ? 'pass' : 'fail'}`}>
          <h2>
            Data integrity <small>re-checks the stored data against the raw responses, last {audit.runsChecked} runs</small>
          </h2>
          <p className="verdict">
            {audit.ok ? <><span className="tick">✓</span> All {audit.checks.length} checks passed.</> : <><span className="cross">✕</span> {audit.checks.filter((c) => !c.ok).length} check(s) failed.</>}
            {audit.cadence.gapsOver45Min > 0
              ? <span className="warn-text"> {audit.cadence.gapsOver45Min} gap{audit.cadence.gapsOver45Min === 1 ? '' : 's'} in collection (longest {audit.cadence.longestGapMinutes} min).</span>
              : <span className="muted"> No gaps in collection.</span>}
          </p>
          <ul className="checks">
            {audit.checks.map((c) => (
              <li key={c.id} className={c.ok ? 'ok' : 'bad'}>
                <span>{c.ok ? '✓' : '✕'}</span> {c.label}
                {c.problems.slice(0, 3).map((pr) => <small key={pr} className="err-text"> {pr}</small>)}
              </li>
            ))}
          </ul>
          {audit.note && <p className="foot">{audit.note}</p>}
        </section>
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
