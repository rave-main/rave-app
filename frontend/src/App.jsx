import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { api } from './api.js';
import AuthForm from './AuthForm.jsx';
import Freshness from './Freshness.jsx';
import Notes from './Notes.jsx';
import Radar from './Radar.jsx';
import { SessionContext, StatusProvider } from './lib.jsx';

// The chart pages pull in Recharts, so they load on demand and the Radar stays light
const DataHealth = lazy(() => import('./DataHealth.jsx'));
const Stock = lazy(() => import('./Stock.jsx'));
const Research = lazy(() => import('./Research.jsx'));
const Settings = lazy(() => import('./Settings.jsx'));

export default function App() {
  // undefined = still checking the session, null = signed out
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    api('/auth/me').then(setUser).catch(() => setUser(null));
  }, []);

  const expire = useCallback(() => setUser(null), []);
  const session = useMemo(() => ({ expire }), [expire]);

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  }

  if (user === undefined) return <div className="app"><p className="muted">Loading…</p></div>;
  if (user === null) {
    return (
      <div className="app">
        <header className="top"><h1 className="brand">RAVE</h1></header>
        <p className="tagline">Retail Attention Volatility Engine</p>
        <AuthForm onSignedIn={setUser} />
      </div>
    );
  }

  return (
    <SessionContext.Provider value={session}>
      <StatusProvider>
        <div className="app">
          <header className="top">
            <div className="brand-wrap">
              <h1 className="brand">RAVE</h1>
              <span className="tagline">Retail Attention Volatility Engine</span>
            </div>
            <div className="header-right">
              <Freshness />
              <span className="who">{user.name}</span>
              <button type="button" className="link" onClick={signOut}>Sign out</button>
            </div>
          </header>
          <nav className="tabs" aria-label="Main">
            <NavLink to="/" end>Radar</NavLink>
            <NavLink to="/research">Research</NavLink>
            <NavLink to="/data">Data</NavLink>
            <NavLink to="/settings">Settings</NavLink>
            <NavLink to="/notes">Notes</NavLink>
          </nav>
          <main>
            <Suspense fallback={<p className="muted">Loading…</p>}>
            <Routes>
              <Route path="/" element={<Radar />} />
              <Route path="/stock/:ticker" element={<Stock />} />
              <Route path="/research" element={<Research />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/data" element={<DataHealth />} />
              <Route path="/notes" element={<Notes key={user.id} onUnauthorized={expire} />} />
              <Route path="*" element={<p className="banner err">Page not found.</p>} />
            </Routes>
            </Suspense>
          </main>
        </div>
      </StatusProvider>
    </SessionContext.Provider>
  );
}
