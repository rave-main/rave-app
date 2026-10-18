import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { Explain, dateTime, signedPct, signedUsd, usePoll } from './lib.jsx';

const LEVEL = {
  insufficient: ['Not enough data yet', 'wait'],
  none: ['No sign of a link', 'none'],
  direction: ['Prices tended to move one way', 'good'],
  size: ['Prices moved further, direction unclear', 'good'],
  both: ['Prices moved further and one way', 'good'],
  marker: ['Not a useful signal on its own', 'none'],
};
const DAYS = { 1: '1 trading day', 5: '5 trading days', 20: '20 trading days' };
const maybeLuck = (p) => (p === null || p === undefined ? '—' : p < 0.025 ? 'Unlikely' : 'Possibly');
const axisLabel = (value, extra = {}) => ({ value, fill: 'var(--muted)', fontSize: 11, ...extra });

function Verdict({ title, v }) {
  if (!v) return null;
  const [name, tone] = LEVEL[v.level] || [v.level, 'none'];
  return (
    <div className={`verdict-card tone-${tone}`}>
      <small>{title}</small>
      <strong>{name}</strong>
      <p>{v.headline}</p>
    </div>
  );
}

// What happened after a spike, in plain numbers: average move, gain or loss against the market, and $ per $1,000
function AfterSpike({ study, title }) {
  return (
    <>
      <h3>{title}</h3>
      <div className="table-wrap">
        <table className="runs">
          <thead>
            <tr>
              <th>Time after buying</th>
              <th className="num" title="Average size of the share's move, up or down, ignoring direction">Average move (up or down)</th>
              <th className="num" title="The same measure on ordinary days for the same shares">…on ordinary days</th>
              <th className="num" title="Gain (+) or loss (−) compared with the overall market, averaged over all spikes">Gain or loss vs market</th>
              <th className="num" title="What the average gain or loss means for $1,000 invested">Per $1,000 invested</th>
              <th className="num" title="Could the extra movement just be chance?">Could it be luck?</th>
              <th className="num">Spikes</th>
            </tr>
          </thead>
          <tbody>
            {Object.keys(study.results).map((h) => {
              const r = study.results[h];
              return (
                <tr key={h}>
                  <td>{DAYS[h] || `${h} days`}</td>
                  <td className="num">{signedPct(r.size?.eventMean).replace(/^\+/, '')}</td>
                  <td className="num">{signedPct(r.size?.controlMean).replace(/^\+/, '')}</td>
                  <td className={`num ${r.direction?.eventMean >= 0 ? 'up' : 'down'}`}>{signedPct(r.direction?.eventMean)}</td>
                  <td className={`num ${r.direction?.eventMean >= 0 ? 'up' : 'down'}`}>{signedUsd((r.direction?.eventMean ?? 0) * 1000)}</td>
                  <td className="num">{maybeLuck(r.size?.p)}</td>
                  <td className="num">{r.size?.n ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Technical({ b }) {
  const row = (study, mode, h, label) => {
    const r = (mode === 'matched' ? study.matched : study.results)[h];
    return (
      <tr key={`${study.lagDays}${mode}${h}`}>
        <td>{study.lagDays} days</td><td>{label}</td><td>{h}</td>
        <td className="num">{r.size ? `${(r.size.mean * 100).toFixed(2)}%` : '—'}</td><td className="num">{r.size ? r.size.p.toFixed(3) : '—'}</td>
        <td className="num">{r.direction ? `${(r.direction.mean * 100).toFixed(2)}%` : '—'}</td><td className="num">{r.direction ? r.direction.p.toFixed(3) : '—'}</td>
      </tr>
    );
  };
  return (
    <Explain title="Technical detail (for the curious)">
      <p>Each row compares the days after a spike with other days for the same shares. "Equally jumpy days" compares with days that followed a similarly volatile stretch, so that a share that was already moving a lot is not mistaken for attention predicting a move. The "p" columns show the chance of seeing a difference this big by luck alone (small = unlikely to be luck). They come from shifting the attention data in time against the prices and repeating the whole test many times.</p>
      <div className="table-wrap">
        <table className="runs">
          <thead><tr><th>Bought after</th><th>Compared with</th><th>Trading days held</th><th className="num">Extra size of move</th><th className="num">p</th><th className="num">Extra gain vs market</th><th className="num">p</th></tr></thead>
          <tbody>
            {[b.conservative, b.optimistic].flatMap((st) => Object.keys(st.results).flatMap((h) => [row(st, 'plain', h, 'Ordinary days'), row(st, 'matched', h, 'Equally jumpy days')]))}
          </tbody>
        </table>
      </div>
    </Explain>
  );
}

function Ledger({ ledger }) {
  return (
    <section className="card">
      <h2>Reddit test, going forward <small>Reddit has no history, so each spike is noted as it happens and judged later</small></h2>
      <div className="meter" role="progressbar" aria-label="Spikes with a 5-day result" aria-valuenow={Math.round(ledger.progress * 100)} aria-valuemin="0" aria-valuemax="100"><i style={{ width: `${ledger.progress * 100}%` }} /></div>
      <p className="muted">{ledger.withFiveDayOutcome} of {ledger.needed} spikes have a 5-day result ({ledger.total} spotted so far). RAVE draws no conclusion until it has {ledger.needed}.</p>
      {ledger.events.length > 0 && (
        <div className="table-wrap">
          <table className="runs">
            <thead><tr><th>Spotted</th><th>Stock</th><th>Label</th><th className="num">Bought (market open)</th><th className="num">After 1 trading day</th><th className="num">After 5</th><th className="num">After 20</th></tr></thead>
            <tbody>
              {ledger.events.slice(0, 20).map((e) => (
                <tr key={e.id}>
                  <td>{dateTime(e.detectedAt)}</td>
                  <td><Link to={`/stock/${e.ticker}`}>{e.ticker}</Link></td>
                  <td>{e.label}{e.wikiLabel && <small> · Wikipedia {e.wikiLabel}</small>}</td>
                  <td className="num">{e.entryOpen ? <>{e.entryDay}<small> at ${e.entryOpen.toFixed(2)}</small></> : <span className="muted">pending</span>}</td>
                  {[1, 5, 20].map((h) => <td key={h} className={`num ${e.outcomes?.[h]?.abn >= 0 ? 'up' : 'down'}`}>{e.outcomes?.[h] ? <>{signedPct(e.outcomes[h].abn)}<small> {signedUsd(e.outcomes[h].abn * 1000)}</small></> : <span className="muted">—</span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!ledger.events.length && <p className="muted">No Hot or Extreme Reddit spikes yet. They appear here by themselves once the 24-hour rating has enough history (about 3 days).</p>}
      <p className="foot">Gain or loss is compared with the overall market (an S&amp;P 500 fund, SPY). The dollar figure is what it would mean for $1,000 invested.</p>
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
        <h2>Does a jump in attention come before big share-price moves?</h2>
        <p className="lede">
          We looked back over the last two years. Each time a company's Wikipedia page views jumped (a "spike"), we asked what the share price did next, compared with the overall market.
        </p>
        {!b && <p className="muted">The first analysis has not run yet. It runs twice a day once Wikipedia views and prices have been collected (see the Data page).</p>}
        {b?.status === 'insufficient' && <p className="banner info">Not enough data yet: {b.reason}.</p>}
        {b?.status === 'ok' && (
          <>
            <p className="muted">{b.universe.tickers} stocks, {b.universe.firstDay} to {b.universe.lastDay}, {b.conservative.events} spikes. Last analysed {dateTime(b.ranAt)}.</p>
            <div className="verdicts">
              <Verdict title="Buying 2 days after the spike (realistic)" v={b.verdict.conservative} />
              <Verdict title="Buying 1 day after the spike (optimistic)" v={b.verdict.optimistic} />
            </div>
            <Explain title="Why 2 days?">Wikipedia only publishes a day's page views once the day has ended, so by the time a spike is known the market has usually already opened. Buying 2 days later is what you could really do; 1 day is shown as the best case.</Explain>
            {b.verdict.conservative.details.map((d) => <p key={d} className="detail">{d}</p>)}
            <AfterSpike study={b.conservative} title="What happened after a spike (buying 2 days later)" />
            <p className="foot">Average move is how far the share price moved, up or down, over that time. "Gain or loss vs market" is how much better (+) or worse (−) it did than the overall market (an S&amp;P 500 fund, SPY). "Could it be luck?" says whether the extra movement could just be chance. All figures run from the market open on the buying day.</p>

            <h3>Does attention come before, or after, the price move?</h3>
            <p className="muted">Each point links a jump in Wikipedia views on one day with how big the share price move was on a day earlier or later. Higher means a stronger link. A peak to the right of 0 would mean attention comes first; a peak at or to the left of 0 means the price moves first or at the same time.</p>
            <div className="chart-box">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={ll} margin={{ top: 8, right: 12, left: 4, bottom: 22 }}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="lag" stroke="var(--muted)" tick={{ fontSize: 11 }} label={axisLabel('Trading days after the attention jump (negative = before)', { position: 'insideBottom', offset: -14 })} />
                  <YAxis stroke="var(--muted)" tick={{ fontSize: 11 }} width={52} tickFormatter={(v) => v.toFixed(2)} label={axisLabel('Strength of link (0 = none, 1 = perfect)', { angle: -90, position: 'insideLeft', offset: 4, style: { textAnchor: 'middle' } })} />
                  <ReferenceLine x={0} stroke="var(--border)" />
                  <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8 }} labelFormatter={(l) => `${l} trading days`} formatter={(v) => (v === null ? '—' : v.toFixed(3))} />
                  <Line type="monotone" dataKey="size" name="Size of price move" stroke="var(--accent)" dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="volume" name="Number of shares traded" stroke="var(--accent-2)" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="legend"><i style={{ background: 'var(--accent)' }} /> size of the price move <i style={{ background: 'var(--accent-2)' }} /> number of shares traded</div>

            <Technical b={b} />
          </>
        )}
        {b?.caveats && (
          <>
            <h3>Things to keep in mind</h3>
            <ul className="caveats">{b.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
          </>
        )}
      </section>
      <Ledger ledger={data.ledger} />
      <p className="foot center">This is research, not financial advice.</p>
    </>
  );
}
