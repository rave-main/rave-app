const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, resetRave, seedHistory } = require('./helpers');
const { simulateCounts } = require('./rave-sim');
const { runEarnings, fetchNextEarnings } = require('../src/rave/earnings');

let pool;
before(async () => ({ pool } = await setup()));
after(() => pool.end());

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const ts = (d) => Date.parse(`${d}T21:00:00Z`) / 1000;

function fakeYahoo({ dates = {}, crumbStatus = 200, summaryStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    if (url.startsWith('https://fc.yahoo.com')) return { ok: false, status: 404, headers: { getSetCookie: () => ['A3=abc123; Expires=x; Domain=.yahoo.com', 'B=zzz; Path=/'] }, text: async () => '' };
    if (url.includes('getcrumb')) {
      assert.match(opts.headers.Cookie, /A3=abc123; B=zzz/);
      return { ok: crumbStatus === 200, status: crumbStatus, text: async () => 'CRUMB1', headers: { getSetCookie: () => [] } };
    }
    const t = decodeURIComponent(url.match(/quoteSummary\/([^?]+)/)[1]);
    assert.match(url, /crumb=CRUMB1/);
    if (summaryStatus !== 200) return { ok: false, status: summaryStatus, json: async () => ({ finance: { error: { description: 'Unauthorized' } } }) };
    const d = dates[t];
    return { ok: true, status: 200, json: async () => ({ quoteSummary: { result: [{ calendarEvents: { earnings: { earningsDate: d ? [{ raw: ts(d) }] : [] } } }] } }) };
  };
  return { fetchImpl, calls };
}

test('the next results date is read from the calendar, and absent dates are null', async () => {
  const { fetchImpl } = fakeYahoo({ dates: { GME: day(12) } });
  assert.equal(await fetchNextEarnings('GME', { cookie: 'A3=abc123; B=zzz', crumb: 'CRUMB1' }, fetchImpl), day(12));
  assert.equal(await fetchNextEarnings('XYZ', { cookie: 'A3=abc123; B=zzz', crumb: 'CRUMB1' }, fetchImpl), null);
});

test('the job stores announced dates, keeps past ones, replaces moved estimates, and re-checks only after five days', async () => {
  await resetRave(pool);
  await pool.query('DELETE FROM universe');
  await seedHistory(pool, { GME: simulateCounts({ days: 2, level: 30, seed: 1 }), TSLA: simulateCounts({ days: 2, level: 30, seed: 2 }) });
  await pool.query(`INSERT INTO earnings_dates (ticker, day) VALUES ('GME', $1), ('GME', $2)`, [day(-40), day(20)]); // one past, one stale estimate
  const y = fakeYahoo({ dates: { GME: day(15), TSLA: day(30) } });
  const first = await runEarnings(pool, { fetchImpl: y.fetchImpl, pauseMs: 0, log: { log() {}, error() {} } });
  assert.deepEqual([first.checked, first.withDate], [2, 2]);
  const { rows } = await pool.query(`SELECT ticker, day::text AS day FROM earnings_dates ORDER BY ticker, day`);
  assert.deepEqual(rows, [{ ticker: 'GME', day: day(-40) }, { ticker: 'GME', day: day(15) }, { ticker: 'TSLA', day: day(30) }]);
  const calls = y.calls.length;
  const second = await runEarnings(pool, { fetchImpl: y.fetchImpl, pauseMs: 0 });
  assert.equal(second.due, 0);
  assert.equal(y.calls.length, calls, 'nothing is requested again so soon');
  const later = await runEarnings(pool, { fetchImpl: y.fetchImpl, pauseMs: 0, now: Date.now() + 6 * 86400000 });
  assert.equal(later.due, 2);
});

test('a refused session fails the run clearly instead of recording nothing silently', async () => {
  await resetRave(pool);
  await pool.query('DELETE FROM universe');
  await seedHistory(pool, { GME: simulateCounts({ days: 2, level: 30, seed: 1 }) });
  const y = fakeYahoo({ summaryStatus: 401 });
  await assert.rejects(runEarnings(pool, { fetchImpl: y.fetchImpl, pauseMs: 0 }), /Yahoo results dates failing/);
  await assert.rejects(runEarnings(pool, { fetchImpl: fakeYahoo({ crumbStatus: 401 }).fetchImpl, pauseMs: 0 }), /crumb request failed/);
});
