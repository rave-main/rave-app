import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { dateTime, num, usePoll } from './lib.jsx';

const p2 = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(2)}%`);
const sig = (m) => (m && m.p < 0.025 ? 'sig' : '');
const LEVEL = { insufficient: 'Not enough data', none: 'No evidence', direction: 'Direction', size: 'Bigger moves', both: 'Bigger and directional', marker: 'Marker, not a predictor' };

function Verdict({ title, v }) {
  if (!v) return null;
  return (
    <div className={`verdict-card lvl-${v.level}`}>
      <small>{title}</small>
      <strong>{LEVEL[v.level] || v.level}</strong>
      <p>{v.headline}</p>
    </div>
  );
}

function StudyTable({ study, title }) {
  const hs = Object.keys(study.results);
  const row = (mode, h, label) => {
    const r = (mode === 'matched' ? study.matched : study.results)[h];
    return (
      <tr key={`${mode}${h}`}>
        <td>{label}</td><td>{h} days</td>
        <td className={`num ${sig(r.size)}`}>{p2(r.size?.eventMean)} <small>vs {p2(r.size?.controlMean)}</small></td>
        <td className="num">{r.size ? r.size.p.toFixed(3) : '—'}</td>
        <td className={`num ${sig(r.direction)}`}>{p2(r.direction?.eventMean)} <small>vs {p2(r.direction?.controlMean)}</small></td>
        <td className="num">{r.direction ? r.direction.p.toFixed(3) : '—'}</td>
        <td className="num">{r.size?.n ?? '—'}</td>
      </tr>
    );
  };
  return (
    <>
      <h3>{title}</h3>
      <div className="table-wrap">
        <table className="runs">
          <thead><tr><th>Compared with</th><th>Hold</th><th className="num">Size of move</th><th className="num">p</th><th className="num">Direction (vs SPY)</th><th className="num">p</th><th className="num">Spikes</th></tr></thead>
          <tbody>{hs.map((h) => row('plain', h, 'Ordinary days'))}{hs.map((h) => row('matched', h, 'Equally volatile days'))}</tbody>
        </table>
      </div>
    </>
  );
}

function Ledger({ ledger }) {
  return (
    <section className="card">
      <h2>Reddit forward test <small>Reddit has no history, so spikes are recorded as they happen and judged later</small></h2>
      <div className="meter" role="progressbar" aria-valuenow={Math.round(ledger.progress * 100)} aria-valuemin="0" aria-valuemax="100"><i style={{ width: `${ledger.progress * 100}%` }} /></div>
      <p className="muted">{ledger.withFiveDayOutcome} of {ledger.needed} spikes have a 5-day outcome ({ledger.total} recorded). No conclusions are drawn before {ledger.needed}.</p>
      {ledger.events.length > 0 && (
        <div className="table-wrap">
          <table className="runs">
            <thead><tr><th>Detected</th><th>Stock</th><th>Label</th><th className="num">Entry</th><th className="num">1d</th><th className="num">5d</th><th className="num">20d</th></tr></thead>
            <tbody>
              {ledger.events.slice(0, 20).map((e) => (
                <tr key={e.id}>
                  <td>{dateTime(e.detectedAt)}</td>
                  <td><Link to={`/stock/${e.ticker}`}>{e.ticker}</Link></td>
                  <td>{e.label}{e.wikiLabel && <small> · wiki {e.wikiLabel}</small>}</td>
                  <td className="num">{e.entryOpen ? `${e.entryDay} @ ${e.entryOpen}` : <span className="muted">pending</span>}</td>
                  {[1, 5, 20].map((h) => <td key={h} className="num">{e.outcomes?.[h] ? p2(e.outcomes[h].abn) : <span className="muted">—</span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!ledger.events.length && <p className="muted">No Hot or Extreme Reddit spikes recorded yet. They appear here automatically as soon as the short-horizon score has enough history.</p>}
    </section>
  );
}

export default function Research() {
  const { data, error } = usePoll('/rave/research', 120000);
  if (error && !data) return <p className="banner err">Could not load research — {error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const b = data.backtest;
  const ll = b?.status === 'ok' ? b.leadLag.map((r) => ({ lag: r.lag, size: r.size?.r ?? null, volume: r.volume?.r ?? null })) : [];

  return (
    <>
      <section className="card">
        <h2>Does attention come before price moves? <small>Wikipedia page views against 5 years of prices, benchmark SPY</small></h2>
        {!b && <p className="muted">The first analysis has not run yet. It runs nightly once Wikipedia views and prices are loaded (Data page).</p>}
        {b?.status === 'insufficient' && <p className="banner info">Not enough data yet: {b.reason}</p>}
        {b?.status === 'ok' && (
          <>
            <p className="muted">{b.signal}. {b.universe.tickers} stocks, {b.universe.firstDay} to {b.universe.lastDay}, {b.conservative.events} spikes. Analysed {dateTime(b.ranAt)}.</p>
            <div className="verdicts">
              <Verdict title="Realistic entry (2 days after the spike)" v={b.verdict.conservative} />
              <Verdict title="Optimistic entry (1 day after)" v={b.verdict.optimistic} />
            </div>
            {b.verdict.conservative.details.map((d) => <p key={d} className="detail">{d}</p>)}
            <StudyTable study={b.conservative} title="Realistic entry: results by holding period" />
            <StudyTable study={b.optimistic} title="Optimistic entry: results by holding period" />
            <p className="foot">Each row compares the stock's price after a spike with the same stock's other days (and, in the second block, with days following an equally volatile stretch, which stops "already volatile" being mistaken for "attention predicts"). Returns are open-to-close and market-adjusted. p-values come from shifting the attention data in time against the prices and redoing the whole test; shaded cells are significant after correcting for two questions.</p>

            <h3>Lead and lag <small className="muted">correlation of a day's attention shock with the price outcome k trading days later; positive k means attention comes first</small></h3>
            <div className="chart-box">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={ll} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="lag" stroke="var(--muted)" tick={{ fontSize: 11 }} />
                  <YAxis stroke="var(--muted)" tick={{ fontSize: 11 }} />
                  <ReferenceLine x={0} stroke="var(--border)" />
                  <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8 }} formatter={(v) => (v === null ? '—' : v.toFixed(3))} />
                  <Line type="monotone" dataKey="size" name="Size of price move" stroke="var(--accent)" dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="volume" name="Trading volume" stroke="var(--accent-2)" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
        {b?.caveats && (
          <>
            <h3>Read this before trusting any result</h3>
            <ul className="caveats">{b.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
          </>
        )}
      </section>
      <Ledger ledger={data.ledger} />
      <p className="foot center">Research tool, not financial advice. {num(data.ledger.total)} Reddit spikes recorded so far.</p>
    </>
  );
}
