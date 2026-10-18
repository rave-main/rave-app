const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, signedInAgent, request } = require('./helpers');

let pool, app;
before(async () => ({ pool, app } = await setup()));
after(() => pool.end());

const insertRun = async (status, ago = '0 minutes', extra = {}) =>
  (await pool.query(
    `INSERT INTO collection_runs (kind, status, started_at, finished_at, pages_fetched, pages_total, tickers_seen, rows_written, market_total_mentions, error)
     VALUES ('apewisdom', $1, now() - $2::interval, now() - $2::interval, 2, 2, 150, 102, 5000, $3) RETURNING *`,
    [status, ago, extra.error ?? null]
  )).rows[0];

test('RAVE endpoints require sign-in', async () => {
  await request(app).get('/api/rave/status').expect(401);
  await request(app).get('/api/rave/stocks').expect(401);
  await request(app).get('/api/rave/watchlist').expect(401);
});

test('watchlist is seeded with the starting stocks and two controls', async () => {
  const { agent } = await signedInAgent(app);
  const { body } = await agent.get('/api/rave/watchlist').expect(200);
  assert.equal(body.length, 10);
  assert.deepEqual(body.filter((w) => w.isControl).map((w) => w.ticker), ['AAPL', 'MSFT']);
  assert.ok(body.some((w) => w.ticker === 'GME' && w.name === 'GameStop'));
});

test('status reports stale with no data, then fresh after a recent run, then stale again when old', async () => {
  await pool.query('TRUNCATE collection_runs, snapshots RESTART IDENTITY CASCADE');
  const { agent } = await signedInAgent(app);

  let { body } = await agent.get('/api/rave/status').expect(200);
  assert.equal(body.stale, true);
  assert.equal(body.lastSuccess, null);

  await insertRun('success', '10 minutes');
  ({ body } = await agent.get('/api/rave/status').expect(200));
  assert.equal(body.stale, false);
  assert.equal(body.lastSuccess.rowsWritten, 102);
  assert.equal(body.last24h.success, 1);

  await pool.query('TRUNCATE collection_runs RESTART IDENTITY CASCADE');
  await insertRun('success', '3 hours');
  await insertRun('failed', '5 minutes', { error: 'upstream down' });
  ({ body } = await agent.get('/api/rave/status').expect(200));
  assert.equal(body.stale, true);
  assert.equal(body.lastRun.status, 'failed');
  assert.equal(body.lastRun.error, 'upstream down');
  assert.equal(body.last24h.failed, 1);
});

test('stocks returns the latest snapshot per watchlist stock, and nulls where none exists yet', async () => {
  await pool.query('TRUNCATE collection_runs, snapshots RESTART IDENTITY CASCADE');
  const { agent } = await signedInAgent(app);
  const run = await insertRun('success');
  const add = (ticker, at, mentions, ranked = true) =>
    pool.query(
      `INSERT INTO snapshots (run_id, ticker, fetched_at, ranked, rank, mentions) VALUES ($1, $2, now() - $3::interval, $4, $5, $6)`,
      [run.id, ticker, at, ranked, ranked ? 3 : null, mentions]
    );
  await add('GME', '2 hours', 10);
  await add('GME', '10 minutes', 99);
  await add('AMC', '10 minutes', 0, false);

  const { body } = await agent.get('/api/rave/stocks').expect(200);
  const byTicker = Object.fromEntries(body.map((s) => [s.ticker, s]));
  assert.equal(body.length, 10);
  assert.equal(byTicker.GME.mentions, 99, 'uses the newest snapshot');
  assert.equal(byTicker.AMC.ranked, false);
  assert.equal(byTicker.TSLA.mentions, null, 'no snapshot yet');
});
