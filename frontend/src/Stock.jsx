import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from './api.js';
import { LabelChip } from './Radar.jsx';
import { Explain, ago, dateTime, num, signedPct, signedUsd, times, unusual, usd, usePoll, useStatus, useTick } from './lib.jsx';

const RANGES = [['24h', 24], ['3d', 72], ['7d', 168], ['30d', 720]];
const HORIZONS = [['short', 'Last 24 hours', 'now compared with a usual day'], ['medium', 'Last 7 days', 'a typical day this week compared with the last 12 weeks'], ['long', 'Last 4 weeks', 'a typical day over 4 weeks compared with earlier history']];
const axisLabel = (value, extra = {}) => ({ value, fill: 'var(--muted)', fontSize: 11, ...extra });
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
              {s.status === 'ok' && m && s.label !== 'Low volume' && <p className="big-num">{times(m.ratio)} <small>its normal level · {unusual(m.z)} · {s.confidence} confidence</small></p>}
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
      setMsg({ type: 'ok', text: 'Saved. Page views for this article are fetched at the next Wikipedia update (or press Run now on the Data page).' });
      setValue('');
      onSaved();
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    }
  }
  return (
    <details className="editor">
      <summary>Wrong Wikipedia page? Change it</summary>
      <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) save(value.trim()); }}>
        <input placeholder="Exact Wikipedia page title, for example GameStop" value={value} onChange={(e) => setValue(e.target.value)} maxLength={200} />
        <button disabled={!value.trim()}>Use this article</button>
        <button type="button" className="link" onClick={() => save(null)}>This stock has no Wikipedia page</button>
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

  if (error?.status === 404) return <p className="banner err">{ticker.toUpperCase()} has not been on the Reddit leaderboard this week. <Link to="/">Back to Radar</Link></p>;
  if (error && !data) return <p className="banner err">Could not load {ticker} — {error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const { latest, scores, history, wiki, spikes, price } = data;
  const points = history.map((p) => ({ t: p.t, mentions: p.mentions, rank: p.rank }));
  const fmtT = (t) => new Date(t).toLocaleString([], hours <= 72 ? { hour: '2-digit', minute: '2-digit', weekday: 'short' } : { month: 'short', day: 'numeric' });
  const monthT = (t) => new Date(t).toLocaleDateString([], { month: 'short', year: '2-digit' });

  return (
    <>
      <p className="crumb"><Link to="/">← Radar</Link></p>
      <header className="stock-head">
        <div>
          <h2>{data.label} <small>{data.name}</small></h2>
          {price && <p className="price-line"><strong>{usd(price.close)}</strong> <small>US$ at the close on {new Date(`${price.day}T00:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' })}</small>
            <span className={price.change1d >= 0 ? 'up' : 'down'}> {signedPct(price.change1d)} <small>1 day</small></span>
            <span className={price.change1w >= 0 ? 'up' : 'down'}> {signedPct(price.change1w)} <small>5 trading days</small></span></p>}
          {price?.swing20 != null && <p className="muted">Typical 20-trading-day swing: ±{(price.swing20 * 100).toFixed(0)}% (up or down, from the last 60 trading days).{price.ran ? ' The price has already moved much more than usual in the last 5 days, so much of a move may be over.' : ''}{' '}
            Size idea: to lose about 1% of your portfolio in a typical 20-day move, hold about {Math.min(25, 1 / (price.swing20 * 100) * 100).toFixed(1)}% of it in this stock (never more than 25%). Calmer stocks get bigger positions. This is risk control, not a prediction; in our tests volatility helped to spot big moves (see Research) but not their direction.</p>}
          {data.results && <p className="muted">Company results expected on {data.results.day} ({data.results.inDays === 0 ? 'today' : `in ${data.results.inDays} day${data.results.inDays === 1 ? '' : 's'}`}). Big price moves are common around results.</p>}
          {latest && <p className="muted">{latest.ranked ? `Reddit rank #${latest.rank}${data.rank24hAgo ? ` (was #${data.rank24hAgo} a day ago)` : ''}` : 'Not on the Reddit leaderboard right now'} · updated {ago(now() - latest.t)}</p>}
          <p className="muted">
            Wikipedia: {wiki.article
              ? <><a href={`https://en.wikipedia.org/wiki/${encodeURIComponent(wiki.article.replace(/ /g, '_'))}`} target="_blank" rel="noreferrer">{wiki.article}</a> <small>({wiki.source === 'override' ? 'set by you' : `automatic match, ${wiki.confidence} confidence`})</small></>
              : <>no article matched{wiki.status === 'pending' ? ' yet' : ''}</>}
          </p>
        </div>
        <div className="big">
          <strong>{latest ? num(latest.mentions) : '—'}</strong>
          <small>Reddit mentions in the last 24 hours{latest?.dayOverDay ? ` · ${latest.dayOverDay.change >= 0 ? '+' : ''}${latest.dayOverDay.change} since yesterday` : ''}</small>
        </div>
      </header>

      <section className="card">
        <div className="toolbar">
          <h3>Reddit mentions <small>number of mentions in the 24 hours before each point</small></h3>
          <div className="seg">{RANGES.map(([text, h]) => <button key={text} className={hours === h ? 'on' : ''} onClick={() => setHours(h)}>{text}</button>)}</div>
        </div>
        {points.length < 2 ? (
          <p className="muted center pad">Only {points.length} reading{points.length === 1 ? '' : 's'} in this range so far; the chart appears after the next check.</p>
        ) : (
          <div className="chart-box">
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={points} margin={{ top: 8, right: 12, left: 4, bottom: 18 }}>
                <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity="0.5" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={fmtT} stroke="var(--muted)" tick={{ fontSize: 11 }} minTickGap={48} label={axisLabel(`Time (your local time), last ${hours <= 24 ? '24 hours' : `${hours / 24} days`}`, { position: 'insideBottom', offset: -12 })} />
                <YAxis stroke="var(--muted)" tick={{ fontSize: 11 }} allowDecimals={false} width={52} label={axisLabel('Mentions in 24 hours', { angle: -90, position: 'insideLeft', offset: 4, style: { textAnchor: 'middle' } })} />
                <Tooltip labelFormatter={(t) => dateTime(t)} contentStyle={tooltipStyle} labelStyle={{ color: 'var(--text)' }} />
                <Area type="monotone" dataKey="mentions" name="Mentions in the previous 24 hours" stroke="var(--accent-2)" strokeWidth={2} fill="url(#g)" dot={points.length < 40} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Wikipedia page views and share price <small>last 13 months, one point per day</small></h3>
        {combined.length < 5 ? (
          <p className="muted center pad">{wiki.article ? 'Page views and prices are still being collected for this stock.' : 'No Wikipedia page or price data for this stock yet.'}</p>
        ) : (
          <div className="chart-box">
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={combined} margin={{ top: 8, right: 8, left: 4, bottom: 18 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={monthT} stroke="var(--muted)" tick={{ fontSize: 11 }} minTickGap={50} label={axisLabel('Date (last 13 months)', { position: 'insideBottom', offset: -12 })} />
                <YAxis yAxisId="v" stroke="var(--muted)" tick={{ fontSize: 11 }} width={52} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} label={axisLabel('Wikipedia page views per day', { angle: -90, position: 'insideLeft', offset: 4, style: { textAnchor: 'middle' } })} />
                <YAxis yAxisId="p" orientation="right" stroke="var(--muted)" tick={{ fontSize: 11 }} width={56} domain={['auto', 'auto']} tickFormatter={(v) => `$${Math.round(v)}`} label={axisLabel('Share price (US$)', { angle: 90, position: 'insideRight', offset: 4, style: { textAnchor: 'middle' } })} />
                <Tooltip labelFormatter={(t) => new Date(t).toLocaleDateString()} contentStyle={tooltipStyle} labelStyle={{ color: 'var(--text)' }} formatter={(v, name) => [name === 'Share price (US$)' ? `$${Number(v).toFixed(2)}` : `${num(v)} views`, name]} />
                <Area yAxisId="v" type="monotone" dataKey="views" name="Page views per day" stroke="var(--accent)" strokeWidth={1.5} fill="var(--accent)" fillOpacity={0.18} connectNulls dot={false} isAnimationActive={false} />
                {spikes.map((sp) => <ReferenceLine key={sp.detectedAt} yAxisId="v" x={Date.parse(`${sp.detectedAt.slice(0, 10)}T00:00:00Z`)} stroke="var(--warn)" strokeDasharray="3 3" label={{ value: 'Reddit spike', fill: 'var(--warn)', fontSize: 10, position: 'insideTopLeft' }} />)}
                <Line yAxisId="p" type="monotone" dataKey="close" name="Share price (US$)" stroke="var(--ok)" strokeWidth={1.6} connectNulls dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        <ArticleEditor ticker={data.ticker} wiki={wiki} onSaved={() => setRefresh((n) => n + 1)} />
      </section>

      <Explain title="How to read the two signals">A signal compares attention now with what is usual for this stock. 1× means normal; 3× means three times as much. <strong>Rising, Hot</strong> and <strong>Extreme</strong> mean attention is unusually high. <strong>Low volume</strong> means too few mentions to tell a real change from chance.</Explain>
      <ScoreCards scores={scores} title="Reddit signal" sub="mentions on Reddit compared with this stock's own history" />
      {wiki.scores && <ScoreCards scores={wiki.scores} title="Wikipedia signal" sub="daily views of the company's Wikipedia page compared with its own history" />}

      {spikes.length > 0 && (
        <section className="card">
          <h3>Past Reddit spikes <small>noted by RAVE as they happened, with what the share price did next</small></h3>
          <div className="table-wrap">
            <table className="runs">
              <thead><tr><th>Spotted</th><th>Label</th><th className="num">Times normal</th><th className="num">Bought (market open)</th><th className="num">After 1 trading day</th><th className="num">After 5</th><th className="num">After 20</th></tr></thead>
              <tbody>
                {spikes.map((s) => (
                  <tr key={s.detectedAt}>
                    <td>{dateTime(s.detectedAt)}</td>
                    <td><LabelChip label={s.label} /></td>
                    <td className="num">{times(s.ratio)}</td>
                    <td className="num">{s.entryDay ? <>{s.entryDay}{s.entryOpen ? <small> at {usd(s.entryOpen)}</small> : null}</> : <span className="muted">pending</span>}</td>
                    {[1, 5, 20].map((h) => <td key={h} className="num">{s.outcomes?.[h] ? <span className={s.outcomes[h].abn >= 0 ? 'up' : 'down'}>{signedPct(s.outcomes[h].abn)}<small> {signedUsd(s.outcomes[h].abn * 1000)}</small></span> : <span className="muted">—</span>}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="foot">Each figure is how much better (+) or worse (−) the share did than the overall market (an S&amp;P 500 fund, SPY), measured from the market open on the buying day, which is the first US market open after the spike was spotted. The dollar figure is what that would mean for $1,000 invested. Trading costs are not included.</p>
        </section>
      )}
    </>
  );
}
