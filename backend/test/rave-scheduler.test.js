const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, resetRave } = require('./helpers');
const { every, lastScheduledAt, nextScheduledAt, isDue, runRecorded, jobsStatus } = require('../src/rave/scheduler');
const { buildJobs } = require('../src/rave/jobs');

let pool;
before(async () => ({ pool } = await setup()));
after(() => pool.end());

const at = (s) => new Date(s);
const job = { kind: 'testjob', label: 'Test', cadence: 'twice a day', times: ['04:30', '16:30'], staleAfterMs: 30 * 3600000 };
const addRun = (status, startedAt, error = null) =>
  pool.query(`INSERT INTO collection_runs (kind, status, started_at, error) VALUES ('testjob', $1, $2, $3)`, [status, startedAt, error]);

test('every() builds the schedule and the last/next scheduled times are right, including across midnight', () => {
  const t = every(30, 2);
  assert.equal(t.length, 48);
  assert.deepEqual([t[0], t[1], t[47]], ['00:02', '00:32', '23:32']);
  assert.equal(lastScheduledAt(t, at('2026-10-18T17:40:00Z')).toISOString(), '2026-10-18T17:32:00.000Z');
  assert.equal(lastScheduledAt(t, at('2026-10-18T17:31:59Z')).toISOString(), '2026-10-18T17:02:00.000Z');
  assert.equal(nextScheduledAt(t, at('2026-10-18T17:40:00Z')).toISOString(), '2026-10-18T18:02:00.000Z');
  assert.equal(lastScheduledAt(['23:00'], at('2026-10-18T01:00:00Z')).toISOString(), '2026-10-17T23:00:00.000Z');
  assert.equal(nextScheduledAt(['23:00'], at('2026-10-18T23:30:00Z')).toISOString(), '2026-10-19T23:00:00.000Z');
});

test('due: never ran, ran before the latest schedule time, or already ran for it', async () => {
  await resetRave(pool);
  const now = at('2026-10-18T17:00:00Z'); // latest scheduled time is 16:30
  assert.equal((await isDue(pool, job, now)).due, true, 'never ran');
  await addRun('success', '2026-10-18T04:31:00Z');
  assert.equal((await isDue(pool, job, now)).due, true, 'last success was for the 04:30 schedule, 16:30 has passed');
  await addRun('success', '2026-10-18T16:31:00Z');
  const done = await isDue(pool, job, now);
  assert.equal(done.due, false);
  assert.match(done.reason, /already ran/);
  assert.equal((await isDue(pool, job, at('2026-10-19T04:31:00Z'))).due, true, 'and again once the next schedule time passes');
});

test('due: a restart or a missed run catches up (success is judged against the latest schedule time only)', async () => {
  await resetRave(pool);
  await addRun('success', '2026-10-16T16:31:00Z'); // two days of downtime
  assert.equal((await isDue(pool, job, at('2026-10-18T09:00:00Z'))).due, true);
});

test('due: failures retry with doubling backoff (5, 10, 20 minutes ...) and a running job is not started twice', async () => {
  await resetRave(pool);
  const now = at('2026-10-18T17:00:00Z');
  await addRun('failed', '2026-10-18T16:40:00Z', 'boom');
  assert.equal((await isDue(pool, job, now)).due, true, '20 minutes after one failure: retry');
  assert.equal((await isDue(pool, job, at('2026-10-18T16:43:00Z'))).due, false, '3 minutes after one failure: back off');
  await addRun('failed', '2026-10-18T16:50:00Z', 'boom');
  assert.equal((await isDue(pool, job, at('2026-10-18T16:58:00Z'))).due, false, 'two failures: wait 10 minutes, only 8 have passed');
  assert.equal((await isDue(pool, job, at('2026-10-18T17:01:00Z'))).due, true, '11 minutes after the second failure: retry');
  await resetRave(pool);
  await addRun('running', '2026-10-18T16:55:00Z');
  const r = await isDue(pool, job, now);
  assert.equal(r.due, false);
  assert.equal(r.reason, 'running');
});

test('runRecorded records success with details, and failure with the error', async () => {
  await resetRave(pool);
  const ok = await runRecorded(pool, { kind: 'rec', run: async () => ({ fetched: 3 }) });
  assert.equal(ok.status, 'success');
  const bad = await runRecorded(pool, { kind: 'rec', run: async () => { throw new Error('nope'); } });
  assert.equal(bad.status, 'failed');
  const { rows } = await pool.query(`SELECT status, details, error FROM collection_runs WHERE kind = 'rec' ORDER BY id`);
  assert.deepEqual(rows.map((r) => r.status), ['success', 'failed']);
  assert.deepEqual(rows[0].details, { fetched: 3 });
  assert.equal(rows[1].error, 'nope');
});

test('runRecorded does not run while another instance holds the job lock, and clears abandoned runs', async () => {
  await resetRave(pool);
  const other = await pool.connect();
  try {
    await other.query("SELECT pg_advisory_lock(hashtext('rave-job:locked'))");
    assert.equal((await runRecorded(pool, { kind: 'locked', run: async () => ({}) })).status, 'skipped');
  } finally {
    await other.query("SELECT pg_advisory_unlock(hashtext('rave-job:locked'))");
    other.release();
  }
  await pool.query(`INSERT INTO collection_runs (kind, status, started_at) VALUES ('stuck', 'running', now() - interval '2 hours')`);
  assert.equal((await runRecorded(pool, { kind: 'stuck', run: async () => ({}) })).status, 'success');
  const { rows } = await pool.query(`SELECT status, error FROM collection_runs WHERE kind = 'stuck' ORDER BY id`);
  assert.equal(rows[0].status, 'failed');
  assert.match(rows[0].error, /abandoned/);
});

test('jobsStatus reports freshness, and the registered jobs have sensible cadences', async () => {
  await resetRave(pool);
  await addRun('success', new Date(Date.now() - 2 * 3600000));
  const [s] = await jobsStatus(pool, [job]);
  assert.equal(s.stale, false);
  assert.ok(s.minutesSinceLastSuccess >= 119 && s.minutesSinceLastSuccess <= 121);
  assert.ok(s.nextScheduledAt instanceof Date);
  const jobs = buildJobs();
  const ape = jobs.find((j) => j.kind === 'apewisdom');
  assert.equal(ape.times.length, 48, 'ApeWisdom every 30 minutes');
  assert.equal(ape.selfRecording, true);
});
