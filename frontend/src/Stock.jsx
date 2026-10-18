import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { LabelChip } from './Radar.jsx';
import { ago, dateTime, num, times, usePoll, useStatus, useTick } from './lib.jsx';

const RANGES = [['24h', 24], ['3d', 72], ['7d', 168], ['30d', 720]];
const HORIZONS = [['short', 'Short', 'last 24 hours'], ['medium', 'Medium', 'typical day this week'], ['long', 'Long', 'typical day over 4 weeks']];

export default function Stock() {
  useTick(15000);
  const { ticker } = useParams();
  const [hours, setHours] = useState(72);
  const { data, error } = usePoll(`/rave/stocks/${ticker}?hours=${hours}`, 60000);
  const { now } = useStatus();

  if (error?.status === 404) return <p className="banner err">{ticker.toUpperCase()} is not on the watchlist. <Link to="/">Back to Radar</Link></p>;
  if (error && !data) return <p className="banner err">Could not load {ticker} — {error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const { latest, scores, history } = data;
  const points = history.map((p) => ({ t: p.t, mentions: p.mentions, rank: p.rank }));
  const fmtT = (t) => new Date(t).toLocaleString([], hours <= 72 ? { hour: '2-digit', minute: '2-digit', weekday: 'short' } : { month: 'short', day: 'numeric' });

  return (
    <>
      <p className="crumb"><Link to="/">← Radar</Link></p>
      <header className="stock-head">
        <div>
          <h2>{data.ticker} <small>{data.name}{data.isControl ? ' · control stock' : ''}</small></h2>
          {latest && <p className="muted">{latest.ranked ? `Rank #${latest.rank}${latest.rank24hAgo ? ` (was #${latest.rank24hAgo} a day ago)` : ''}` : 'Not on the leaderboard right now'} · updated {ago(now() - latest.t)}</p>}
        </div>
        <div className="big">
          <strong>{latest ? num(latest.mentions) : '—'}</strong>
          <small>mentions in 24h{latest?.dayOverDay ? ` · ${latest.dayOverDay.change >= 0 ? '+' : ''}${latest.dayOverDay.change} vs yesterday` : ''}</small>
        </div>
      </header>

      <section className="card">
        <div className="toolbar">
          <h3>Mentions over time</h3>
          <div className="seg">{RANGES.map(([text, h]) => <button key={text} className={hours === h ? 'on' : ''} onClick={() => setHours(h)}>{text}</button>)}</div>
        </div>
        {points.length < 2 ? (
          <p className="muted center pad">Only {points.length} snapshot{points.length === 1 ? '' : 's'} in this range so far; the chart appears after the next check.</p>
        ) : (
          <div className="chart-box">
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={points} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity="0.5" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={fmtT} stroke="var(--muted)" tick={{ fontSize: 11 }} minTickGap={48} />
                <YAxis stroke="var(--muted)" tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip labelFormatter={(t) => dateTime(t)} contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8 }} labelStyle={{ color: 'var(--text)' }} />
                <Area type="monotone" dataKey="mentions" name="Mentions (24h)" stroke="var(--accent-2)" strokeWidth={2} fill="url(#g)" dot={points.length < 40} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className="score-grid">
        {HORIZONS.map(([k, name, desc]) => {
          const s = scores[k];
          const m = s.adjusted || s.raw;
          return (
            <article key={k} className="card score">
              <header><h3>{name}</h3><LabelChip label={s.label} /></header>
              <p className="muted">{desc}</p>
              {s.status === 'ok' && m && <p className="big-num">{times(m.ratio)} <small>normal · z {m.z.toFixed(1)} · confidence {s.confidence}</small></p>}
              <p className="why">{s.explanation}</p>
            </article>
          );
        })}
      </section>
    </>
  );
}
