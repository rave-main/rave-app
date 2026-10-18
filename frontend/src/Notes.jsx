import { useEffect, useState } from 'react';
import { api } from './api.js';

export default function Notes({ onUnauthorized }) {
  const [notes, setNotes] = useState([]);
  const [form, setForm] = useState({ title: '', body: '' });
  const [msg, setMsg] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // A 401 means the session expired: send the user back to the sign-in screen
  function fail(err) {
    if (err.status === 401) return onUnauthorized();
    setMsg({ type: 'err', text: err.message });
  }

  useEffect(() => {
    api('/notes').then(setNotes).catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setMsg(null);
    try {
      const note = await api('/notes', { method: 'POST', body: form });
      setNotes((prev) => [note, ...prev]);
      setForm({ title: '', body: '' });
    } catch (err) {
      fail(err);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id) {
    try {
      await api(`/notes/${id}`, { method: 'DELETE' });
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch (err) {
      fail(err);
    }
  }

  return (
    <section className="card">
      <h2>Your notes ({notes.length})</h2>
      <form onSubmit={handleSubmit}>
        <input placeholder="Title" value={form.title} maxLength={100} required onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <textarea placeholder="Note (optional)" value={form.body} maxLength={5000} rows={3} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        <button disabled={submitting}>{submitting ? 'Saving…' : 'Add note'}</button>
        {msg && <p className={`banner ${msg.type}`}>{msg.text}</p>}
      </form>
      <ul className="notes">
        {notes.map((n) => (
          <li key={n.id}>
            <div>
              <strong>{n.title}</strong>
              {n.body && <p>{n.body}</p>}
              <small>{new Date(n.createdAt).toLocaleString()}</small>
            </div>
            <button type="button" className="link danger" onClick={() => handleDelete(n.id)} aria-label={`Delete ${n.title}`}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
