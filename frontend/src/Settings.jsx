import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api.js';
import { usePoll } from './lib.jsx';

function Row({ w, reload }) {
  const [val, setVal] = useState(w.article || '');
  const [msg, setMsg] = useState('');
  async function save(article) {
    try { await api(`/rave/wiki/${w.ticker}`, { method: 'PUT', body: { article } }); setMsg('Saved'); reload(); } catch (e) { setMsg(e.message); }
  }
  return (
    <tr>
      <td><Link to={`/stock/${w.ticker}`}><strong>{w.ticker}</strong></Link><small>{w.name}</small></td>
      <td><span className={`chip ${w.article ? (w.confidence === 'low' ? 'rising' : 'quiet') : 'low-volume'}`}>{w.article ? w.confidence : w.status}</span></td>
      <td>
        <form className="inline" onSubmit={(e) => { e.preventDefault(); save(val.trim() || null); }}>
          <input value={val} onChange={(e) => setVal(e.target.value)} placeholder="Wikipedia article title" aria-label={`Wikipedia article for ${w.ticker}`} />
          <button type="submit">Save</button>
          {msg && <small className="muted"> {msg}</small>}
        </form>
      </td>
    </tr>
  );
}

export default function Settings() {
  const { data: watch } = usePoll('/rave/watchlist', 300000);
  const { data: wiki, reload } = usePoll('/rave/wiki', 300000);
  return (
    <>
      <section className="card">
        <h2>Watchlist <small>always tracked; the rest of the leaderboard joins when it reaches 5 mentions in a day</small></h2>
        {watch ? (
          <p>{watch.filter((w) => w.active).map((w) => <span key={w.ticker} className="chip quiet pill">{w.ticker}{w.isControl ? ' · control' : ''}</span>)}</p>
        ) : <p className="muted">Loading…</p>}
        <p className="foot">Controls are large, steady stocks used as a sanity check: they should rarely show spikes.</p>
      </section>

      <section className="card">
        <h2>Alerts <small>placeholder</small></h2>
        <div className="placeholder">
          <strong>Slack</strong>
          <p className="muted">Get a message when a stock turns Hot or Extreme. Not built yet: this card reserves its place in the design.</p>
          <button type="button" disabled>Connect Slack</button>
        </div>
      </section>

      <section className="card">
        <h2>Wikipedia article for each stock <small>matched automatically; correct any that are wrong</small></h2>
        {!wiki ? <p className="muted">Loading…</p> : (
          <div className="table-wrap">
            <table className="runs">
              <thead><tr><th>Stock</th><th>Match</th><th>Article</th></tr></thead>
              <tbody>{wiki.map((w) => <Row key={`${w.ticker}${w.article}${w.source}`} w={w} reload={reload} />)}</tbody>
            </table>
          </div>
        )}
        <p className="foot">A wrong article would make the Wikipedia signal meaningless for that stock, so check the "low" matches. Clearing the box removes the match; a manual choice is never overwritten.</p>
      </section>
    </>
  );
}
