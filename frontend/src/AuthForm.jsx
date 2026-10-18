import { useState } from 'react';
import { api } from './api.js';

export default function AuthForm({ onSignedIn }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isRegister = mode === 'register';

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const { name, email, password } = form;
      const user = await api(`/auth/${mode}`, {
        method: 'POST',
        body: isRegister ? { name, email, password } : { email, password },
      });
      onSignedIn(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  return (
    <section className="card auth">
      <h2>{isRegister ? 'Create an account' : 'Sign in'}</h2>
      <form onSubmit={handleSubmit}>
        {isRegister && (
          <input placeholder="Name" autoComplete="name" value={form.name} maxLength={50} required onChange={set('name')} />
        )}
        <input type="email" placeholder="Email" autoComplete="email" value={form.email} maxLength={100} required onChange={set('email')} />
        <input
          type="password"
          placeholder={isRegister ? 'Password (8+ characters)' : 'Password'}
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          value={form.password}
          minLength={isRegister ? 8 : undefined}
          maxLength={72}
          required
          onChange={set('password')}
        />
        <button disabled={submitting}>
          {submitting ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
        </button>
        {error && <p className="banner err">{error}</p>}
      </form>
      <p className="switch">
        {isRegister ? 'Already have an account?' : 'New here?'}{' '}
        <button type="button" className="link" onClick={() => { setMode(isRegister ? 'login' : 'register'); setError(''); }}>
          {isRegister ? 'Sign in' : 'Create an account'}
        </button>
      </p>
    </section>
  );
}
