import { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

export const SessionContext = createContext({ expire: () => {} });

// Polls an API path while the tab is visible; keeps the previous data on errors and refreshes on tab focus
export function usePoll(path, intervalMs, { enabled = true } = {}) {
  const { expire } = useContext(SessionContext);
  const [state, setState] = useState({ data: null, error: null, loadedAt: null });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let timer;
    const load = async () => {
      clearTimeout(timer);
      if (!document.hidden) {
        try {
          const data = await api(path);
          if (alive) setState({ data, error: null, loadedAt: Date.now() });
        } catch (err) {
          if (err.status === 401) expire();
          else if (alive) setState((s) => ({ ...s, error: err }));
        }
      }
      if (alive) timer = setTimeout(load, intervalMs);
    };
    const onVisible = () => !document.hidden && load();
    load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [path, intervalMs, enabled, expire, version]);

  return { ...state, reload: () => setVersion((v) => v + 1) };
}

// Re-renders on an interval so relative times keep ticking
export function useTick(ms = 15000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

// RAVE status shared by the header indicator, Radar and Data pages. `now()` is the server's clock, so
// "x minutes ago" is right even if the visitor's computer clock is off.
export const StatusContext = createContext({ status: null, error: null, now: () => Date.now() });
export const useStatus = () => useContext(StatusContext);

export function StatusProvider({ children }) {
  const { data: status, error, loadedAt } = usePoll('/rave/status', 30000);
  const skew = status ? new Date(status.now).getTime() - loadedAt : 0;
  const now = () => Date.now() + skew;
  return <StatusContext.Provider value={{ status, error, now }}>{children}</StatusContext.Provider>;
}

export function ago(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export const num = (n) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US'));
export const times = (r) => (r === null || r === undefined ? '—' : `${r >= 10 ? Math.round(r) : r.toFixed(1)}×`);
export const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const dateTime = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// Money and price changes. Prices are US dollars.
export const usd = (n) => (n === null || n === undefined ? '—' : `$${n >= 100 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toFixed(2)}`);
export const signedPct = (x, digits = 1) => {
  if (x === null || x === undefined) return '—';
  const v = (Math.abs(x) * 100).toFixed(digits);
  return Number(v) === 0 ? `${v}%` : `${x >= 0 ? '+' : '−'}${v}%`;
};
export const signedUsd = (x) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : '−'}$${Math.abs(Math.round(x)).toLocaleString('en-US')}`);

// A small "what does this mean?" note that opens on click
export function Explain({ title = 'What does this mean?', children }) {
  return (
    <details className="explain">
      <summary>{title}</summary>
      <div>{children}</div>
    </details>
  );
}

// z-score in plain words (z measures how many typical day-to-day swings away from normal today is)
export function unusual(z) {
  if (z === null || z === undefined) return '';
  if (z >= 4) return 'very unusual';
  if (z >= 3) return 'unusual';
  if (z >= 2) return 'elevated';
  if (z <= -3) return 'unusually low';
  if (z <= -2) return 'low';
  return 'normal range';
}
export const pct = (ratio) => (ratio === null || ratio === undefined ? null : `${ratio >= 1 ? '+' : '−'}${Math.round(Math.abs(ratio - 1) * 100)}%`);
