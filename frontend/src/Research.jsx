import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useMemo, useState } from 'react';
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
              <th className="num" title="Average size of the share's move, up or down, ignoring direction">Average move</th>
              <th className="num" title="The same measure on ordinary days for the same shares">…on ordinary days</th>
              <th className="num" title="Gain (+) or loss (−) compared with the overall market, averaged over all spikes">Vs market</th>
              <th className="num" title="What the average gain or loss means for $1,000 invested">Per $1,000</th>
              <th className="num" title="Could the extra movement just be chance?">Bigger move just luck?</th>
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

function Ledger({ ledger, title, intro, kind = 'reddit' }) {
  return (
    <section className="card">
      <h2>{title} <small>{intro}</small></h2>
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
                  <td>{e.label}{kind === 'reddit' && e.wikiLabel && <small> · Wikipedia {e.wikiLabel}</small>}</td>
                  <td className="num">{e.entryOpen ? <>{e.entryDay}<small> at ${e.entryOpen.toFixed(2)}</small></> : <span className="muted">pending</span>}</td>
                  {[1, 5, 20].map((h) => <td key={h} className={`num ${e.outcomes?.[h]?.abn >= 0 ? 'up' : 'down'}`}>{e.outcomes?.[h] ? <>{signedPct(e.outcomes[h].abn)}<small> {signedUsd(e.outcomes[h].abn * 1000)}</small></> : <span className="muted">—</span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!ledger.events.length && <p className="muted">No spikes noted yet. They appear here by themselves as soon as one happens.</p>}
      <p className="foot">Gain or loss is compared with the overall market (an S&amp;P 500 fund, SPY). The dollar figure is what it would mean for $1,000 invested.</p>
    </section>
  );
}

const pc = (x, d = 1) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`);
const dollars = (x) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : '−'}$${Math.abs(Math.round(x)).toLocaleString('en-US')}`);
const RANGE_COLOURS = ['var(--accent)', 'var(--accent-2)', 'var(--ok)', 'var(--warn)', '#8ab4ff', 'var(--muted)'];

// A figure with its plausible range, coloured when the range excludes zero
function Gain({ s }) {
  if (!s || !s.n) return <span className="muted">—</span>;
  if (s.mean === undefined) return <span className="muted">{s.n} (too few)</span>;
  const clear = s.ci && (s.ci[0] > 0 || s.ci[1] < 0);
  return <span className={clear ? (s.mean > 0 ? 'up' : 'down') : ''}>{pc(s.mean)}<small> ({pc(s.ci[0])} to {pc(s.ci[1])})</small></span>;
}

function Answer({ lab }) {
  const robust = lab.rules.filter((r) => r.dev.mean > 0 && r.holdout.mean > 0 && r.dev.quartersPositive + r.holdout.quartersPositive >= 0.65 * (r.dev.quarters.length + r.holdout.quarters.length));
  const bestHold = lab.rules.filter((r) => !r.id.endsWith('Jump')).sort((a, b) => b.holdout.mean - a.holdout.mean)[0];
  return (
    <div className={`verdict-card ${robust.length ? 'tone-good' : 'tone-none'} wide`}>
      <small>The short answer</small>
      <strong>{robust.length ? 'A rule held up in both periods (treat with care)' : 'No trading rule we tried made money reliably'}</strong>
      <p>
        {robust.length
          ? `${robust.map((r) => r.label).join('; ')}: positive after costs in both the earlier period and the last six months, and in most quarters. Even so, this is a small sample, so it is only worth following in the forward tests below.`
          : `We tested ${lab.variantsTried} ways of using attention spikes (and two rules that ignore attention). Rules that looked profitable in one period lost money in another, and none was profitable in most quarters after costs. The best of them over the last six months, "${bestHold.label.toLowerCase()}", made ${dollars(bestHold.holdout.totalDollars)} in total, but it lost money in the earlier period (${dollars(bestHold.dev.totalDollars)}), so it is more likely luck than a real edge.`}
      </p>
    </div>
  );
}

function Swings({ lab }) {
  const rows = lab.swings.rows;
  const groups = [...new Set(rows.map((r) => r.volatility))];
  return (
    <section className="card">
      <h2>Step 1: what makes a share price swing? <small>a swing is a move of more than {lab.setup.bigMove * 100}% (up or down, compared with the market) within 5 trading days</small></h2>
      <p className="lede">We split every day into four groups by how jumpy the share had already been over the previous month, then asked how often a big swing followed. Next to each, the same figure when attention had just spiked.</p>
      <div className="table-wrap">
        <table className="runs">
          <thead><tr><th>How jumpy the share already was</th><th className="num">Big swing, no spike</th><th className="num">Big swing, after a spike</th><th className="num">Typical move, no spike</th><th className="num">Typical move, after a spike</th></tr></thead>
          <tbody>
            {groups.map((g) => {
              const a = rows.find((r) => r.volatility === g && !r.spike);
              const b = rows.find((r) => r.volatility === g && r.spike);
              return (
                <tr key={g}>
                  <td>{g}</td>
                  <td className="num">{a ? `${(a.bigShare * 100).toFixed(1)}%` : '—'}<small> of {a?.n.toLocaleString('en-US')} days</small></td>
                  <td className="num">{b ? `${(b.bigShare * 100).toFixed(1)}%` : '—'}<small> of {b?.n.toLocaleString('en-US')} days</small></td>
                  <td className="num">{a ? `${(a.typicalMove * 100).toFixed(1)}%` : '—'}</td>
                  <td className="num">{b ? `${(b.typicalMove * 100).toFixed(1)}%` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="foot">Reading it: big swings are mostly about how jumpy a share already is (about 1 in 70 five-day periods for the calmest shares, about 1 in 4 for the jumpiest). An attention spike adds little on top of that. Scheduled events such as company results also cause big swings; we do not yet have results dates, so that is not separated out.</p>
    </section>
  );
}

function Direction({ lab }) {
  return (
    <section className="card">
      <h2>Step 2: after a spike, does the price go up or down? <small>average gain or loss compared with the market over the next 5 trading days, buying 2 days after the spike</small></h2>
      <p className="lede">If swings cannot be told apart from up and down, they cannot be traded. We looked at {lab.direction.length} situations chosen in advance. With that many looks, one or two will seem special by pure chance, so a result only counts if it holds in both periods.</p>
      <div className="table-wrap">
        <table className="runs">
          <thead><tr><th>Situation</th><th className="num">Spikes (earlier)</th><th className="num">Average gain (range), earlier</th><th className="num">Spikes (last 6 months)</th><th className="num">Average gain (range), last 6 months</th></tr></thead>
          <tbody>
            {lab.direction.map((d) => (
              <tr key={d.label}>
                <td>{d.label}</td>
                <td className="num">{d.development.n}</td><td className="num"><Gain s={d.development} /></td>
                <td className="num">{d.holdout.n}</td><td className="num"><Gain s={d.holdout} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="foot">The range is the plausible spread of the true average (95%), found by resampling whole shares. Coloured figures have a range that does not include zero. On shares in general the same measure was {pc(lab.baseline.development.mean)} in the earlier period and {pc(lab.baseline.holdout.mean)} in the last six months.</p>
    </section>
  );
}

function Rules({ lab }) {
  const data = useMemo(() => {
    const days = new Map();
    lab.rules.forEach((r, k) => r.curve.forEach((p) => { const row = days.get(p.day) || { day: p.day }; row[`r${k}`] = p.dollars; days.set(p.day, row); }));
    return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }, [lab]);
  return (
    <section className="card">
      <h2>Step 3: would a simple rule have made money? <small>$1,000 in each trade, held 5 trading days, costs included</small></h2>
      <p className="lede">Each rule trades every spike it matches: $1,000 in the share and an equal amount of the S&amp;P 500 fund (SPY) on the other side, so only the share's gain or loss against the market counts. Costs: {pc(lab.setup.costs.roundTrip + lab.setup.costs.hedge, 2).replace('+', '')} to trade, plus {lab.setup.costs.borrowPerYear * 100}% a year to borrow shares when betting against a spike.</p>
      <Answer lab={lab} />
      <div className="table-wrap">
        <table className="runs">
          <thead><tr><th>Rule</th><th className="num">Trades</th><th className="num">Per trade, before costs</th><th className="num">After costs</th><th className="num">Total (US$)</th><th className="num">Good quarters</th></tr></thead>
          <tbody>
            {lab.rules.flatMap((r, k) => [['Earlier period', r.dev], ['Last 6 months', r.holdout]].map(([p, x], j) => (
              <tr key={`${r.id}${p}`}>
                <td>{j === 0 ? <><i className="swatch" style={{ background: RANGE_COLOURS[k] }} /> {r.label}</> : <span className="muted">&nbsp;&nbsp;&nbsp;&nbsp;{p}</span>}{j === 0 && <small className="block muted">{p}</small>}</td>
                <td className="num">{x.n}</td>
                <td className="num">{pc(x.grossMean, 2)}</td>
                <td className={`num ${x.mean > 0 ? 'up' : 'down'}`}>{pc(x.mean, 2)}</td>
                <td className={`num ${x.totalDollars > 0 ? 'up' : 'down'}`}>{dollars(x.totalDollars)}</td>
                <td className="num">{x.quartersPositive} of {x.quarters.length}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
      <h3>Running total if $1,000 had gone into every trade</h3>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 22 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="day" stroke="var(--muted)" tick={{ fontSize: 11 }} minTickGap={50} tickFormatter={(d) => d.slice(0, 7)} label={axisLabel('Date the trade ended', { position: 'insideBottom', offset: -14 })} />
            <YAxis stroke="var(--muted)" tick={{ fontSize: 11 }} width={72} tickFormatter={(v) => `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US')}`} label={axisLabel('Total profit or loss (US$)', { angle: -90, position: 'insideLeft', offset: -2, style: { textAnchor: 'middle' } })} />
            <ReferenceLine y={0} stroke="var(--border)" />
            <ReferenceLine x={data.find((d) => d.day >= lab.setup.holdoutStart)?.day} stroke="var(--warn)" strokeDasharray="4 4" label={{ value: 'last 6 months', fill: 'var(--warn)', fontSize: 10, position: 'insideTopRight' }} />
            <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8 }} formatter={(v, name) => [`$${Number(v).toLocaleString('en-US')}`, lab.rules[Number(name.slice(1))].label]} />
            {lab.rules.map((r, k) => <Line key={r.id} type="stepAfter" dataKey={`r${k}`} name={`r${k}`} stroke={RANGE_COLOURS[k]} dot={false} connectNulls isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="legend">{lab.rules.map((r, k) => <span key={r.id}><i style={{ background: RANGE_COLOURS[k] }} /> {r.label}</span>)}</div>
      <Explain title="How sensitive is this to costs?">
        <div className="table-wrap"><table className="runs"><thead><tr><th>Rule (last 6 months)</th><th className="num">No costs</th><th className="num">0.2% costs</th><th className="num">0.4% costs</th></tr></thead>
          <tbody>{lab.rules.map((r) => <tr key={r.id}><td>{r.label}</td>{r.holdout.sensitivity.map((v, i) => <td key={i} className={`num ${v > 0 ? 'up' : 'down'}`}>{pc(v, 2)}</td>)}</tr>)}</tbody></table></div>
        <p>Average gain per trade after the stated trading cost (plus borrowing for bets against a spike).</p>
      </Explain>
      <p className="foot">The "last 6 months" were looked at while exploring, so they are not a fully fresh test. The forward tests below, which started when they were added, are.</p>
    </section>
  );
}

const pcs = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`);
const fx = (x, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? '—' : x.toFixed(d));
const HORIZON_NAME = { 20: '4 weeks (20 trading days)', 60: '12 weeks (60 trading days)' };

function Lab2({ lab }) {
  const horizons = Object.keys(lab.horizons);
  const [h, setH] = useState(horizons[0]);
  const e = lab.horizons[h];
  if (!e) return null;
  const rows = [
    ...e.models.flatMap((m) => [{ key: `${m.id}-s`, label: `${m.label}: big shifts, then direction`, r: m.all }, { key: `${m.id}-d`, label: `${m.label}: direction only`, r: m.directionOnly }]),
    ...e.baselines.map((b) => ({ key: b.id, label: b.label, r: b, base: true })),
  ];
  const clear = (r) => r.ci && r.ci[0] > 0;
  const winners = rows.filter((x) => !x.base && clear(x.r) && Object.values(x.r.byYear).filter((y) => y.n >= 2).every((y) => y.mean > 0));
  return (
    <section className="card">
      <h2>Looking over years <small>spot big shifts, then call the direction</small></h2>
      <p className="lede">
        Every week, for every company that was in the S&amp;P 500, 400 or 600 at that time, RAVE asks two questions using only what was known that day: will the share move much more than
        usual over the next 4 or 12 weeks (a big shift, up or down), and if it does, will it be up? The models are retrained every quarter on the past only, so nothing is tested on data it has seen.
        Companies that left the index are included, so results are not flattered by only looking at survivors.
      </p>
      <p className="muted">{lab.stocks.toLocaleString('en-US')} companies, {lab.observations.toLocaleString('en-US')} weekly observations{lab.coverage ? `; ${lab.coverage.removedWithPrices} of ${lab.coverage.removedTotal} companies that left an index have price history` : ''}.</p>
      <div className="seg" role="tablist" aria-label="Horizon">
        {horizons.map((k) => <button key={k} className={h === k ? 'on' : ''} onClick={() => setH(k)}>{Number(k) === 20 ? '4 weeks' : '12 weeks'}</button>)}
      </div>
      <div className={`verdict-card ${winners.length ? 'tone-good' : 'tone-none'} wide`}>
        <small>The short answer for {HORIZON_NAME[h]}</small>
        <strong>{winners.length ? 'Something held up (treat with care)' : 'No version made money reliably'}</strong>
        <p>{winners.length ? `${winners.map((w) => w.label).join('; ')} made money after costs, in every year, with a range that stays above zero. Check it in the forward test before trusting it.` : 'None had a plausible range that stayed above zero after costs, in every year. The Wikipedia, results-date and news inputs are shown so you can see what each adds.'}</p>
      </div>
      <h3>Step 1: can big shifts be spotted?</h3>
      <p className="muted">All scores are <strong>test scores</strong> (AUC): every quarter the model is trained on earlier weeks only, with a gap before the test quarter, then scored on the quarter it has never seen. 0.5 is chance and 1 is perfect. Two meanings of "big" are tested.</p>
      <div className="table-wrap"><table className="runs">
        <thead><tr><th>Question</th><th>Inputs</th><th className="num" title="Test AUC: 0.5 means no better than chance, 1 means perfect">Test score (0.5 = chance)</th><th className="num" title="Average of the separate quarterly test scores">Average quarter</th><th className="num" title="How many times more often it happens among the tenth of rows the model rates most likely">Top tenth hit rate</th><th className="num">Happens in</th></tr></thead>
        <tbody>
          {e.models.slice(0, 1).map((m) => m.stage1.size && (
            <tr key={`${m.id}-size`}><td>Price moves by at least {Math.round(m.stage1.size.threshold * 100)}% (up or down) in {HORIZON_NAME[h]}</td><td>{m.label}</td><td className="num">{fx(m.stage1.size.auc)}</td><td className="num">{fx(m.stage1.size.quarterAuc)}</td><td className="num">{m.stage1.size.lift ? `${m.stage1.size.lift.toFixed(2)}× as often` : '—'}</td><td className="num">{pcs(m.stage1.size.base, 0).replace('+', '')} of weeks</td></tr>
          ))}
          {e.models.slice(0, 1).map((m) => m.stage1.size && (
            <tr key={`${m.id}-vol`} className="baseline"><td>Same question, using only the share's volatility over 120 days</td><td>One number</td><td className="num">{fx(m.stage1.size.volatilityOnlyAuc)}</td><td className="num">—</td><td className="num">—</td><td className="num">—</td></tr>
          ))}
          {e.models.map((m) => <tr key={`${m.id}-rel`}><td>Price moves at least twice as much as is usual for that share in {HORIZON_NAME[h]}</td><td>{m.label}</td><td className="num">{fx(m.stage1.auc)}</td><td className="num">{fx(m.stage1.quarterAuc)}</td><td className="num">{m.stage1.lift ? `${m.stage1.lift.toFixed(2)}× as often` : '—'}</td><td className="num">{pcs(m.stage1.base, 0).replace('+', '')} of weeks</td></tr>)}
        </tbody>
      </table></div>
      <p className="muted">Reading it: "moves by at least X%" is easy to rank above 0.70, but the volatility-only row shows that is almost entirely "jumpy shares move more", which the model does not improve on. "Twice as much as usual for that share" removes that and is much harder: volatility alone scores below chance on it and the model reaches about 0.62 to 0.65.</p>
      {e.calibration?.length > 0 && (
        <Explain title="Is the chance of a big move honest? (calibration)">
          <div className="table-wrap"><table className="runs">
            <thead><tr><th>Group of weeks and stocks (lowest to highest predicted chance)</th><th className="num">Predicted chance</th><th className="num">Move actually happened</th><th className="num">Test rows</th></tr></thead>
            <tbody>{e.calibration.map((c, i) => <tr key={i}><td>{i + 1} of {e.calibration.length}</td><td className="num">{pcs(c.predicted, 0).replace('+', '')}</td><td className="num">{pcs(c.actual, 0).replace('+', '')}</td><td className="num">{c.n.toLocaleString('en-US')}</td></tr>)}</tbody>
          </table></div>
          <p>Test rows are sorted by the model's predicted chance of a move of at least the size above and cut into ten equal groups. If the two percentages are close, the number on each stock page can be read as a probability. These are test rows only, never used for training. The middle groups are slightly under-confident because recent months were more volatile than the years the model learned from.</p>
        </Explain>
      )}
      <h3>Step 2: when there is a big shift, can the direction be called?</h3>
      <div className="table-wrap"><table className="runs">
        <thead><tr><th>Inputs</th><th className="num">Big shifts</th><th className="num">Went up</th><th className="num" title="0.5 means no better than a coin toss">Score (0.5 = chance)</th><th className="num" title="Average of the quarterly scores, so one market mood cannot flatter it">Typical quarter</th></tr></thead>
        <tbody>{e.models.map((m) => <tr key={m.id}><td>{m.label}</td><td className="num">{m.stage2.n.toLocaleString('en-US')}</td><td className="num">{pcs(m.stage2.upRate - 0, 0).replace('+', '')}</td><td className="num">{fx(m.stage2.auc)}</td><td className="num">{fx(m.stage2.quarterAuc)}</td></tr>)}</tbody>
      </table></div>
      <h3>Step 3: would trading it have made money?</h3>
      <p className="muted">Buy the tenth of stocks the score likes most and sell short the tenth it likes least, equal amounts, holding for {HORIZON_NAME[h]}; the market is hedged, so only the stock picking counts. Costs {pcs(0.0032, 2).replace('+', '')} to trade and 5% a year to borrow shares for the shorts are taken off.</p>
      <div className="table-wrap"><table className="runs">
        <thead><tr><th>Rule</th><th className="num">Average per period, after costs</th><th className="num">Plausible range</th><th className="num">Periods</th><th className="num">Winning periods</th><th className="num">Buy side alone</th></tr></thead>
        <tbody>{rows.map((x) => (
          <tr key={x.key} className={x.base ? 'baseline' : ''}>
            <td>{x.label}</td>
            <td className={`num ${x.r.lsNet > 0 ? 'up' : 'down'}`}>{pcs(x.r.lsNet)}</td>
            <td className="num">{x.r.ci ? `${pcs(x.r.ci[0])} to ${pcs(x.r.ci[1])}` : '—'}</td>
            <td className="num">{x.r.periods}</td>
            <td className="num">{x.r.hit === null || Number.isNaN(x.r.hit) ? '—' : `${Math.round(x.r.hit * 100)}%`}</td>
            <td className="num">{pcs(x.r.longNet)}</td>
          </tr>))}</tbody>
      </table></div>
      <Explain title="Results by year">
        <div className="table-wrap"><table className="runs"><thead><tr><th>Rule</th>{Object.keys(rows[0].r.byYear).map((y) => <th key={y} className="num">{y}</th>)}</tr></thead>
          <tbody>{rows.map((x) => <tr key={x.key}><td>{x.label}</td>{Object.keys(rows[0].r.byYear).map((y) => <td key={y} className={`num ${x.r.byYear[y]?.mean > 0 ? 'up' : 'down'}`}>{x.r.byYear[y] ? pcs(x.r.byYear[y].mean) : '—'}</td>)}</tr>)}</tbody></table></div>
        <p>Average result per period in each calendar year (market hedged, costs included). A rule worth trusting is positive in most years, not just in total.</p>
      </Explain>
      <p className="foot">The "random scores" line shows what luck and costs alone give; a rule has to beat it clearly. Momentum and "calmest minus jumpiest" are well-known simple rules, shown so you can see whether the attention, results-date and news inputs add anything beyond them. Retrained every quarter; the first 40% of the history is training only.</p>
    </section>
  );
}

export default function Research() {
  const { data, error } = usePoll('/rave/research', 120000);
  if (error && !data) return <p className="banner err">Could not load research — {error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const b = data.backtest;
  const lab = data.lab?.status === 'ok' ? data.lab : null;
  const lab2 = data.lab2?.status === 'ok' ? data.lab2 : null;
  const ll = b?.status === 'ok' ? b.leadLag.map((r) => ({ lag: r.lag, size: r.size?.r ?? null, volume: r.volume?.r ?? null })) : [];

  return (
    <>
      <section className="card">
        <h2>Can attention spikes make money? <small>what we found, step by step</small></h2>
        <p className="lede">We ask three questions in turn: what makes share prices swing, whether a swing can be split into up and down, and whether a simple trading rule would have made money. All of it uses Wikipedia page views (people looking up a company) with about two years of share prices.</p>
        {!lab && <p className="muted">The analysis runs twice a day and has not produced results yet.</p>}
      </section>
      {lab2 && <Lab2 lab={lab2} />}
      {lab && <><Swings lab={lab} /><Direction lab={lab} /><Rules lab={lab} /></>}

      <section className="card">
        <h2>The original test <small>spikes compared with ordinary days</small></h2>
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
            <p className="foot">Average move is how far the share price moved, up or down, over that time. "Gain or loss vs market" is how much better (+) or worse (−) it did than the overall market (an S&amp;P 500 fund, SPY). "Bigger move just luck?" says whether the extra movement after a spike could just be chance. All figures run from the market open on the buying day.</p>

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
      <Ledger ledger={data.ledger} title="Reddit test, going forward" intro="Reddit has no history, so each spike is noted as it happens and judged later" />
      {data.ledgerWiki && <Ledger ledger={data.ledgerWiki} title="Wikipedia test, going forward" intro="The rules above, frozen from the day they were added. This is the fair test: nothing here was chosen after seeing the results" kind="wiki" />}
      <p className="foot center">This is research, not financial advice.</p>
    </>
  );
}
