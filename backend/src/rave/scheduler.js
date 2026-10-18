// Due-based scheduler. Every job has fixed UTC times ("HH:MM"). A job is DUE when no successful run has started since
// the most recent scheduled time, so a deploy, restart or missed run catches up on its own, and a run that failed is
// retried with backoff until the next scheduled time takes over. State lives in `collection_runs`, not in memory.
const TICK_MS = 30 * 1000;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;
const ABANDONED_AFTER_MIN = 30;
const CONTINUE_AFTER_MS = 5 * 60 * 1000; // a run that stopped at its time limit continues this long afterwards

const pad = (n) => String(n).padStart(2, '0');
const every = (minutes, offset = 0) => {
  const out = [];
  for (let m = offset; m < 24 * 60; m += minutes) out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  return out;
};

// The most recent scheduled time at or before `now`
function lastScheduledAt(times, now = new Date()) {
  const t = now.getTime();
  const day = Math.floor(t / 86400000) * 86400000;
  let best = null;
  for (const dayStart of [day - 86400000, day]) {
    for (const hhmm of times) {
      const [h, m] = hhmm.split(':').map(Number);
      const at = dayStart + (h * 60 + m) * 60000;
      if (at <= t && (best === null || at > best)) best = at;
    }
  }
  return best === null ? null : new Date(best);
}

function nextScheduledAt(times, now = new Date()) {
  const t = now.getTime();
  const day = Math.floor(t / 86400000) * 86400000;
  let best = null;
  for (const dayStart of [day, day + 86400000]) {
    for (const hhmm of times) {
      const [h, m] = hhmm.split(':').map(Number);
      const at = dayStart + (h * 60 + m) * 60000;
      if (at > t && (best === null || at < best)) best = at;
    }
  }
  return new Date(best);
}

async function isDue(pool, job, now = new Date()) {
  const mark = lastScheduledAt(job.times, now);
  if (!mark) return { due: false, reason: 'no schedule' };
  const { rows: [r] } = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'success' AND started_at >= $2::timestamptz AND coalesce(details->>'partial', 'false') <> 'true')::int AS ok_since,
            max(finished_at) FILTER (WHERE status = 'success' AND started_at >= $2::timestamptz AND details->>'partial' = 'true') AS last_partial,
            count(*) FILTER (WHERE status = 'failed' AND started_at >= $2::timestamptz)::int AS failed_since,
            max(started_at) FILTER (WHERE status = 'failed' AND started_at >= $2::timestamptz) AS last_failed,
            count(*) FILTER (WHERE status = 'running' AND started_at > $3::timestamptz - interval '${ABANDONED_AFTER_MIN} minutes')::int AS running
     FROM collection_runs WHERE kind = $1`,
    [job.kind, mark, now]
  );
  if (r.ok_since > 0) return { due: false, reason: 'already ran for this schedule', mark };
  if (r.running > 0) return { due: false, reason: 'running', mark };
  if (r.last_partial && now.getTime() - new Date(r.last_partial).getTime() < CONTINUE_AFTER_MS) return { due: false, reason: 'continuing shortly (the last run stopped at its time limit)', mark };
  if (r.last_failed) {
    const wait = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (r.failed_since - 1));
    if (now.getTime() - new Date(r.last_failed).getTime() < wait) return { due: false, reason: 'backing off after a failure', mark };
  }
  return { due: true, reason: r.failed_since ? 'retrying after a failure' : 'scheduled', mark };
}

// Runs a job that does not record itself (everything except ApeWisdom): one row in collection_runs per attempt
async function runRecorded(pool, job, { log = console } = {}) {
  const lock = await pool.connect();
  try {
    const { rows: [{ locked }] } = await lock.query("SELECT pg_try_advisory_lock(hashtext('rave-job:' || $1)) AS locked", [job.kind]);
    if (!locked) return { status: 'skipped', reason: 'another instance holds the lock' };
    await pool.query(
      `UPDATE collection_runs SET status = 'failed', finished_at = now(), error = 'abandoned (process stopped mid-run)'
       WHERE kind = $1 AND status = 'running' AND started_at < now() - interval '${ABANDONED_AFTER_MIN} minutes'`,
      [job.kind]
    );
    const { rows: [run] } = await pool.query(`INSERT INTO collection_runs (kind, status) VALUES ($1, 'running') RETURNING id`, [job.kind]);
    try {
      const details = (await job.run(pool, { log })) || {};
      await pool.query(`UPDATE collection_runs SET status = 'success', finished_at = now(), details = $2 WHERE id = $1`, [run.id, JSON.stringify(details)]);
      return { status: 'success', runId: run.id, details };
    } catch (err) {
      await pool.query(`UPDATE collection_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [run.id, String(err.message || err).slice(0, 500)]);
      return { status: 'failed', runId: run.id, error: err.message };
    }
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('rave-job:' || $1))", [job.kind]).catch(() => {});
    lock.release();
  }
}

// jobs: [{ kind, label, times, staleAfterMs, run(pool, ctx) }]. A job with `selfRecording: true` (ApeWisdom) records
// its own runs and returns { status }.
function startScheduler(pool, jobs, { log = console, tickMs = TICK_MS, firstTickMs = 5000 } = {}) {
  const running = new Set();
  let stopped = false;
  let timer;

  const tickJob = async (job) => {
    if (running.has(job.kind)) return;
    running.add(job.kind);
    try {
      const due = await isDue(pool, job);
      if (!due.due) return;
      const result = job.selfRecording ? await job.run(pool, { log }) : await runRecorded(pool, job, { log });
      log.log(`RAVE ${job.kind}: ${JSON.stringify(result).slice(0, 300)}`);
    } catch (err) {
      log.error(`RAVE ${job.kind} crashed:`, err);
    } finally {
      running.delete(job.kind);
    }
  };
  const tick = () => {
    jobs.forEach((job) => tickJob(job)); // jobs run concurrently; each has its own in-flight guard and DB lock
    if (!stopped) timer = setTimeout(tick, tickMs);
  };
  timer = setTimeout(tick, firstTickMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

// Freshness of every job for the Data page
async function jobsStatus(pool, jobs, now = new Date()) {
  const out = [];
  for (const job of jobs) {
    const [{ rows: [ok] }, { rows: [last] }] = await Promise.all([
      pool.query(`SELECT id, started_at AS "startedAt", finished_at AS "finishedAt", details FROM collection_runs WHERE kind = $1 AND status = 'success' ORDER BY started_at DESC LIMIT 1`, [job.kind]),
      pool.query(`SELECT status, started_at AS "startedAt", error FROM collection_runs WHERE kind = $1 ORDER BY started_at DESC LIMIT 1`, [job.kind]),
    ]);
    const ageMs = ok ? now.getTime() - new Date(ok.startedAt).getTime() : null;
    out.push({
      kind: job.kind,
      label: job.label,
      cadence: job.cadence,
      lastSuccess: ok || null,
      lastRun: last || null,
      stale: ageMs === null || ageMs > job.staleAfterMs,
      minutesSinceLastSuccess: ageMs === null ? null : Math.round(ageMs / 60000),
      nextScheduledAt: nextScheduledAt(job.times, now),
    });
  }
  return out;
}

module.exports = { every, lastScheduledAt, nextScheduledAt, isDue, runRecorded, startScheduler, jobsStatus, TICK_MS };
