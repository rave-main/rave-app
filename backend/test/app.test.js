const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, signedInAgent, request } = require('./helpers');
const { originMatcher } = require('../src/app');

let pool, app;
before(async () => ({ pool, app } = await setup()));
after(() => pool.end());

test('health endpoints report the API and database', async () => {
  await request(app).get('/health').expect(200);
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(res.body.database, 'ok');
});

test('CORS allows listed and wildcard origins and rejects others', async () => {
  await request(app).get('/health').set('Origin', 'https://app.example').expect(200)
    .expect('access-control-allow-origin', 'https://app.example');
  await request(app).get('/health').set('Origin', 'https://rave-abc123-team.vercel.app').expect(200);
  const res = await request(app).get('/health').set('Origin', 'https://evil.example').expect(403);
  assert.equal(res.body.error, 'Origin not allowed');
});

test('origin wildcard only matches a single host label', () => {
  const allowed = originMatcher('https://*-team.vercel.app');
  assert.equal(allowed('https://rave-x1-team.vercel.app'), true);
  assert.equal(allowed('https://evil.com/-team.vercel.app'), false);
  assert.equal(allowed('https://a.b-team.vercel.app'), false);
  assert.equal(allowed('http://rave-x1-team.vercel.app'), false);
});

test('analytics requires sign-in', async () => {
  await request(app).get('/api/analytics').expect(401);
  const { agent } = await signedInAgent(app);
  const res = await agent.get('/api/analytics').expect(200);
  assert.equal(res.body.length, 7);
});

test('rejects oversized and malformed bodies, unknown routes', async () => {
  await request(app).post('/api/auth/login').set('Content-Type', 'application/json')
    .send(JSON.stringify({ email: 'x'.repeat(11000) })).expect(413);
  await request(app).post('/api/auth/login').set('Content-Type', 'application/json')
    .send('{bad').expect(400);
  await request(app).get('/api/nope').expect(404);
});
