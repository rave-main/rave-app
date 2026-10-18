import { useEffect, useState } from 'react';
import { api } from './api.js';
import AuthForm from './AuthForm.jsx';
import Analytics from './Analytics.jsx';
import Notes from './Notes.jsx';

export default function App() {
  const [health, setHealth] = useState(null);
  const [apiError, setApiError] = useState('');
  // undefined = still checking the session, null = signed out
  const [user, setUser] = useState(undefined);
  const [analytics, setAnalytics] = useState([]);

  useEffect(() => {
    api('/health')
      .then(setHealth)
      .catch((err) => setApiError(`Could not reach the API — ${err.message}`));
    api('/auth/me')
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!user) return setAnalytics([]);
    api('/analytics')
      .then(setAnalytics)
      .catch((err) => (err.status === 401 ? setUser(null) : setApiError(err.message)));
  }, [user]);

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  }

  return (
    <div className="app">
      <header>
        <h1>Rave App</h1>
        <div className="header-right">
          <span className={`status ${health ? 'up' : apiError ? 'down' : ''}`}>
            {health ? 'API online' : apiError ? 'API offline' : 'Connecting…'}
          </span>
          {user && (
            <>
              <span className="who">{user.name}</span>
              <button type="button" className="link" onClick={signOut}>Sign out</button>
            </>
          )}
        </div>
      </header>

      {apiError && <p className="banner err">{apiError}</p>}

      {user === null && <AuthForm onSignedIn={setUser} />}
      {user && (
        <>
          <Notes key={user.id} onUnauthorized={() => setUser(null)} />
          <Analytics data={analytics} />
        </>
      )}

      <footer>
        {health && <>Database {health.database} · last health check {new Date(health.timestamp).toLocaleTimeString()}</>}
      </footer>
    </div>
  );
}
