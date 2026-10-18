import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api.js';
import { Explain, usePoll } from './lib.jsx';

function Row({ w, reload }) {
  const [val, setVal] = useState(w.article || '');
  const [msg, setMsg] = useState('');
  async function save(article) {
    try { await api(`/rave/wiki/${w.ticker}`, { method: 'PUT', body: { article } }); setMsg('Saved'); reload(); } catch (e) { setMsg(e.message); }
  }
  return (
    <tr>
      <td><Link to={`/stock/${w.ticker}`}><strong>{w.label}</strong></Link><small>{w.name}</small></td>
      <td><span className={`chip ${w.article ? (w.confidence === 'low' ? 'rising' : 'quiet') : 'low-volume'}`}>{w.article ? `${w.confidence} confidence` : w.status === 'pending' ? 'not looked up yet' : 'no page found'}</span></td>
      <td>
        <form className="inline" onSubmit={(e) => { e.preventDefault(); save(val.trim() || null); }}>
          <input value={val} onChange={(e) => setVal(e.target.value)} placeholder="Wikipedia page title" aria-label={`Wikipedia page for ${w.ticker}`} />
          <button type="submit">Save</button>
          {msg && <small className="muted"> {msg}</small>}
        </form>
      </td>
    </tr>
  );
}

export default function Settings() {
  const { data: wiki, reload } = usePoll('/rave/wiki', 300000);
  const [filter, setFilter] = useState('check');
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(50);
  const rows = useMemo(() => {
    if (!wiki) return [];
    const needle = q.trim().toLowerCase();
    return wiki.filter((w) => (filter === 'all' || (w.article ? w.confidence === 'low' : true)) && (!needle || w.label.toLowerCase().includes(needle) || w.name.toLowerCase().includes(needle)));
  }, [wiki, filter, q]);
  return (
    <>
      <section className="card">
        <h2>Which stocks are tracked?</h2>
        <p>All of them. RAVE tracks every stock on the Reddit leaderboard (about 800), so you can compare them all. Quiet stocks are kept but marked "Low volume" because they are mentioned too rarely to rate.</p>
      </section>

      <section className="card">
        <h2>Alerts <small>coming later</small></h2>
        <div className="placeholder">
          <strong>Slack</strong>
          <p className="muted">Get a message when a stock turns Hot or Extreme. Not built yet: this card keeps its place in the design.</p>
          <button type="button" disabled>Connect Slack</button>
        </div>
      </section>

      <section className="card">
        <h2>Wikipedia page for each stock <small>found automatically; correct any that are wrong</small></h2>
        <Explain>RAVE needs to know which Wikipedia page belongs to each company, so it can count page views. It guesses from the company name. A wrong page would give a meaningless Wikipedia signal for that stock, so check the ones marked "low confidence" or "no page found". Your choice is never overwritten.</Explain>
        <div className="toolbar">
          <div className="seg">
            <button className={filter === 'check' ? 'on' : ''} onClick={() => { setFilter('check'); setShown(50); }}>Needs checking</button>
            <button className={filter === 'all' ? 'on' : ''} onClick={() => { setFilter('all'); setShown(50); }}>All stocks</button>
          </div>
          <input className="search" type="search" placeholder="Search ticker or name" value={q} onChange={(e) => { setQ(e.target.value); setShown(50); }} />
        </div>
        {!wiki ? <p className="muted">Loading…</p> : (
          <div className="table-wrap">
            <table className="runs">
              <thead><tr><th>Stock</th><th>Match</th><th>Wikipedia page</th></tr></thead>
              <tbody>
                {rows.slice(0, shown).map((w) => <Row key={`${w.ticker}${w.article}${w.source}`} w={w} reload={reload} />)}
                {!rows.length && <tr><td colSpan="3" className="muted center">Nothing to show.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > shown && <p className="center"><button type="button" onClick={() => setShown(shown + 100)}>Show more ({rows.length - shown} more)</button></p>}
      </section>
    </>
  );
}
