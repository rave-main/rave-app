import { useEffect, useState } from 'react';

const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '');

async function api(path, options) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = data.details ? `: ${data.details.join(', ')}` : '';
    throw new Error(`${data.error || `Request failed (${res.status})`}${details}`);
  }
  return data;
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [users, setUsers] = useState([]);
  const [analytics, setAnalytics] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', email: '' });
  const [formMsg, setFormMsg] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([api('/health'), api('/api/users'), api('/api/analytics')])
      .then(([h, u, a]) => {
        setHealth(h);
        setUsers(u);
        setAnalytics(a);
      })
      .catch((err) => setError(`Could not reach API at ${API_URL} — ${err.message}`));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setFormMsg(null);
    try {
      const user = await api('/api/users', { method: 'POST', body: JSON.stringify(form) });
      setUsers((prev) => [...prev, user]);
      setForm({ name: '', email: '' });
      setFormMsg({ type: 'ok', text: `Added ${user.name}` });
    } catch (err) {
      setFormMsg({ type: 'err', text: err.message });
    } finally {
      setSubmitting(false);
    }
  }

  const maxViews = Math.max(1, ...analytics.map((d) => d.pageViews));

  return (
    <div className="app">
      <header>
        <h1>Rave App</h1>
        <span className={`status ${health ? 'up' : error ? 'down' : ''}`}>
          {health ? 'API online' : error ? 'API offline' : 'Connecting…'}
        </span>
      </header>

      {error && <p className="banner err">{error}</p>}

      <section className="card">
        <h2>Analytics (last 7 days)</h2>
        <div className="chart">
          {analytics.map((d) => (
            <div key={d.date} className="bar-col" title={`${d.pageViews} page views`}>
              <span className="bar-value">{d.pageViews}</span>
              <div className="bar" style={{ height: `${(d.pageViews / maxViews) * 100}%` }} />
              <span className="bar-label">{d.date.slice(5)}</span>
            </div>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Date</th><th>Users</th><th>Page views</th><th>Bounce rate</th></tr>
            </thead>
            <tbody>
              {analytics.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td><td>{d.users}</td><td>{d.pageViews}</td><td>{d.bounceRate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Users ({users.length})</h2>
        <ul className="users">
          {users.map((u) => (
            <li key={u.id}>
              <strong>{u.name}</strong>
              <span>{u.email}</span>
              <small>Joined {u.joined}</small>
            </li>
          ))}
        </ul>

        <form onSubmit={handleSubmit}>
          <h3>Add user</h3>
          <input
            placeholder="Name"
            value={form.name}
            maxLength={50}
            required
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            type="email"
            placeholder="Email"
            value={form.email}
            maxLength={100}
            required
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <button disabled={submitting}>{submitting ? 'Adding…' : 'Add user'}</button>
          {formMsg && <p className={`banner ${formMsg.type}`}>{formMsg.text}</p>}
        </form>
      </section>

      <footer>
        API: <code>{API_URL}</code>
        {health && <> · last health check {new Date(health.timestamp).toLocaleTimeString()}</>}
      </footer>
    </div>
  );
}
