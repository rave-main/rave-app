import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ago, clock, useStatus, useTick } from './lib.jsx';

// Collector cadence is ~30 min plus up to 5 min of jitter
const JITTER_MIN = 5;

export function freshness(status, now) {
  if (!status) return { level: 'unknown', checkedMs: null, changedMs: null, nextMin: null };
  const checkedMs = status.lastSuccess ? now() - new Date(status.lastSuccess.startedAt).getTime() : null;
  const changedMs = status.lastChangeAt ? now() - new Date(status.lastChangeAt).getTime() : null;
  const nextMin = checkedMs === null ? null : status.expectedIntervalMinutes + JITTER_MIN - checkedMs / 60000;
  const mins = checkedMs === null ? Infinity : checkedMs / 60000;
  const level = mins <= status.expectedIntervalMinutes + JITTER_MIN + 10 ? 'live' : mins <= 90 ? 'delayed' : 'stale';
  return { level, checkedMs, changedMs, nextMin };
}

const WORDS = { live: 'Live', delayed: 'Delayed', stale: 'Stale', unknown: 'Connecting' };

// The header indicator: is RAVE collecting, and when did the data last change?
export default function Freshness({ compact = false }) {
  useTick(15000);
  const { status, error, now } = useStatus();
  const f = freshness(status, now);
  const lastRunId = status?.lastSuccess?.id;
  const seen = useRef(null);
  const [flash, setFlash] = useState(false);

  // Brief highlight when a new collection run lands while the page is open
  useEffect(() => {
    if (!lastRunId) return undefined;
    if (seen.current !== null && seen.current !== lastRunId) {
      setFlash(true);
      const id = setTimeout(() => setFlash(false), 4000);
      seen.current = lastRunId;
      return () => clearTimeout(id);
    }
    seen.current = lastRunId;
    return undefined;
  }, [lastRunId]);

  const level = error && !status ? 'stale' : f.level;
  const checked = f.checkedMs === null ? 'no data yet' : `checked ${ago(f.checkedMs)}`;
  const changed = status?.lastChangeAt
    ? `data last changed ${ago(f.changedMs)}`
    : status?.lastSuccess ? 'no data change seen yet' : '';
  const title = status?.lastSuccess
    ? `Last check ${clock(status.lastSuccess.startedAt)}. ${changed}. ${f.nextMin > 0 ? `Next check in about ${Math.ceil(f.nextMin)} min.` : 'Next check is due.'}`
    : 'Waiting for the first collection';

  return (
    <Link to="/data" className={`fresh ${level} ${flash ? 'flash' : ''}`} title={title}>
      <span className="dot" />
      <strong>{flash ? 'New data' : WORDS[level]}</strong>
      {!compact && <span className="fresh-detail">{checked}</span>}
    </Link>
  );
}
