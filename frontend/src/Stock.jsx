import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from './api.js';
import { LabelChip } from './Radar.jsx';
import { ago, dateTime, num, pct, times, unusual, usePoll, useStatus, useTick } from './lib.jsx';

const RANGES = [['24h', 24], ['3d', 72], ['7d', 168], ['30d', 720]];
const HORIZONS = [['short', 'Short', 'latest reading'], ['medium', 'Medium', 'typical day this week'], ['long', 'Long', 'typical day over 4 weeks']];
const tooltipStyle = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8 };

function ScoreCards({ scores, title, sub }) {
  return (
    <>
      <h3 className="section-title">{title} <small>{sub}</small></h3>
      <section className="score-grid">
        {HORIZONS.map(([k, name, desc]) => {
          const s = scores[k];
          const m = s.adjusted || s.raw;
          return (
            <article key={k} className="card score">
              <header><h3>{name}</h3><LabelChip label={s.label} /></header>
              <p className="muted">{desc}</p>
              {s.status === 'ok' && m && s.label !== 'Low volume' && <p className="big-num">{times(m.ratio)} <small>normal · {unusual(m.z)} · confidence {s.confidence}</small></p>}
              <p className="why">{s.explanation}</p>
            </article>
          );
        })}
      </section>
    </>
  );
}

function ArticleEditor({ ticker, wiki, onSaved }) {
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState(null);
  async function save(article) {
    setMsg(null);
    try {
      await api(`/rave/wiki/${ticker}`, { method: 'PUT', body: { article } });
      setMsg({ type: 'ok', text: 'Saved. Page views for this article are fetched at the next Wikipedia run (or run it now from the Data page).' });
      setValue('');
      onSaved();
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    }
  }
  return (
    <details className="editor">
      <summary>Wrong article? Fix it</summary>
      <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) save(value.trim()); }}>
        <input placeholder="Exact Wikipedia page title, e.g. GameStop" value={value} onChange={(e) => setValue(e.target.value)} maxLength={200} />
        <button disabled={!value.trim()}>Use this article</button>
        <button type="button" className="link" onClick={() => save(null)}>No article for this stock</button>
      </form>
      {msg && <p className={`banner ${msg.type}`}>{msg.text}</p>}
    </details>
  );
}

export default function Stock() {
  useTick(15000);
  const { ticker } = useParams();
  const [hours, setHours] = useState(72);
  const { data, error } = usePoll(`/rave/stocks/${ticker}?hours=${hours}`, 60000);
  const { now } = useStatus();
  const [refresh, setRefresh] = useState(0); // bumps the query after an article change

  const combined = useMemo(() => {
    if (!data) return [];
    const byDay = new Map();
    for (const p of data.wiki.history) byDay.set(new Date(p.t).toISOString().slice(0, 10), { t: p.t, views: p.views });
    for (const p of data.prices) {
      const row = byDay.get(p.day) || { t: Date.parse(`${p.day}T00:00:00Z`) };
      row.close = p.close;
      byDay.set(p.day, row);
    }
    return [...byDay.values()].sort((a, b) => a.t - b.t);
  }, [data, refresh]);

  if (error?.status === 404) return <p className="banner err">{ticker.toUpperCase()} has not appeared on the leaderboard. <Link to="/">Back to Radar</Link></p>;
  if (error && !data) return <p className="banner err">Could not load {ticker} — {error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const { latest, scores, history, wiki, spikes } = data;
  const points = history.map((p) => ({ t: p.t, mentions: p.mentions, rank: p.rank }));
  const fmtT = (t) => new Date(t).toLocaleString([], hours <= 72 ? { hour: '2-digit', minute: '2-digit', weekday: 'short' } : { month: 'short', day: 'numeric' });
  const monthT = (t) => new Date(t).toLocaleDateString([], { month: 'short', year: '2-digit' });

  return (
    <>
      <p className="crumb"><Link to="/">← Radar</Link></p>
      <header className="stock-head">
        <div>
          <h2>{data.ticker} <small>{data.name}{data.isControl ? ' · control stock' : data.isWatchlist ? ' · watchlist' : ''}</small></h2>
          {latest && <p className="muted">{latest.ranked ? `Reddit rank #${latest.rank}${latest.rank24hAgo ? ` (was #${latest.rank24hAgo} a day ago)` : ''}` : 'Not on the Reddit leaderboard right now'} · updated {ago(now() - latest.t)}</p>}
          <p className="muted">
            Wikipedia: {wiki.article
              ? <><a href={`https://en.wikipedia.org/wiki/${encodeURIComponent(wiki.article.replace(/ /g, '_'))}`} target="_blank" rel="noreferrer">{wiki.article}</a> <small>({wiki.source === 'override' ? 'set by you' : `automatic match, ${wiki.confidence} confidence`})</small></>
              : <>no article matched{wiki.status === 'pending' ? ' yet' : ''}</>}
          </p>
        </div>
        <div className="big">
          <strong>{latest ? num(latest.mentions) : '—'}</strong>
          <small>mentions in 24h{latest?.dayOverDay ? ` · ${latest.dayOverDay.change >= 0 ? '+' : ''}${latest.dayOverDay.change} vs yesterday` : ''}</small>
        </div>
      </header>

      <section className="card">
        <div className="toolbar">
          <h3>Reddit mentions over time</h3>
          <div className="seg">{RANGES.map(([text, h]) => <button key={text} className={hours === h ? 'on' : ''} onClick={() => setHours(h)}>{text}</button>)}</div>
        </div>
        {points.length < 2 ? (
          <p className="muted center pad">Only {points.length} reading{points.length === 1 ? '' : 's'} in this range so far; the chart appears after the next check.</p>
        ) : (
          <div className="chart-box">
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={points} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity="0.5" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={fmtT} stroke="var(--muted)" tick={{ fontSize: 11 }} minTickGap={48} />
                <YAxis stroke="var(--muted)" tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip labelFormatter={(t) => dateTime(t)} contentStyle={tooltipStyle} labelStyle={{ color: 'var(--text)' }} />
                <Area type="monotone" dataKey="mentions" name="Mentions (24h)" stroke="var(--accent-2)" strokeWidth={2} fill="url(#g)" dot={points.length < 40} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Wikipedia page views and price <small>last 13 months</small></h3>
        {combined.length < 5 ? (
          <p className="muted center pad">{wiki.article ? 'Page views and prices are still being collected for this stock.' : 'No Wikipedia article or no price data for this stock yet.'}</p>
        ) : (
          <div className="chart-box">
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={combined} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={monthT} stroke="var(--muted)" tick={{ fontSize: 11 }} minTickGap={50} />
                <YAxis yAxisId="v" stroke="var(--muted)" tick={{ fontSize: 11 }} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} />
                <YAxis yAxisId="p" orientation="right" stroke="var(--muted)" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                <Tooltip labelFormatter={(t) => new Date(t).toLocaleDateString()} contentStyle={tooltipStyle} labelStyle={{ color: 'var(--text)' }} formatter={(v, name) => [name === 'Close price' ? `$${Number(v).toFixed(2)}` : num(v), name]} />
                <Area yAxisId="v" type="monotone" dataKey="views" name="Page views (daily)" stroke="var(--accent)" strokeWidth={1.5} fill="var(--accent)" fillOpacity={0.18} connectNulls dot={false} isAnimationActive={false} />
                <Line yAxisId="p" type="monotone" dataKey="close" name="Close price" stroke="var(--ok)" strokeWidth={1.6} connectNulls dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        <ArticleEditor ticker={data.ticker} wiki={wiki} onSaved={() => setRefresh((n) => n + 1)} />
      </section>

      <ScoreCards scores={scores} title="Reddit signal" sub="Reddit mentions, compared with this stock's own history" />
      {wiki.scores && <ScoreCards scores={wiki.scores} title="Wikipedia signal" sub="daily views of the company's article, compared with its own history" />}

      {spikes.length > 0 && (
        <section className="card">
          <h3>Past Reddit spikes <small>recorded by RAVE as they happened</small></h3>
          <div className="table-wrap">
            <table className="runs">
              <thead><tr><th>Detected</th><th>Label</th><th className="num">vs normal</th><th className="num">Entry</th><th className="num">1 day</th><th className="num">5 days</th><th className="num">20 days</th></tr></thead>
              <tbody>
                {spikes.map((s) => (
                  <tr key={s.detectedAt}>
                    <td>{dateTime(s.detectedAt)}</td>
                    <td><LabelChip label={s.label} /></td>
                    <td className="num">{times(s.ratio)}</td>
                    <td className="num">{s.entryDay || <span className="muted">pending</span>}</td>
                    {[1, 5, 20].map((h) => <td key={h} className="num">{s.outcomes?.[h] ? <span className={s.outcomes[h].abn >= 0 ? 'up' : 'down'}>{s.outcomes[h].abn >= 0 ? '+' : ''}{(s.outcomes[h].abn * 100).toFixed(1)}%</span> : <span className="muted">—</span>}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="foot">Market-adjusted return (versus SPY) from the open of the entry day, which is the first US market open after the spike was detected.</p>
        </section>
      )}
    </>
  );
}
