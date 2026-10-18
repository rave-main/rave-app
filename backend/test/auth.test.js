const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, signedInAgent, request } = require('./helpers');

let pool, app;
before(async () => ({ pool, app } = await setup()));
after(() => pool.end());

test('register creates a user, sets an httpOnly session cookie and never returns the hash', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: '  Alice   Johnson ', email: 'Alice@Example.com', password: 'password123' })
    .expect(201);
  assert.equal(res.body.name, 'Alice Johnson');
  assert.equal(res.body.email, 'alice@example.com');
  assert.equal(res.body.password_hash, undefined);
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, /^sid=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  const { rows } = await pool.query('SELECT password_hash FROM users WHERE email = $1', ['alice@example.com']);
  assert.notEqual(rows[0].password_hash, 'password123');
});

test('register rejects duplicates (case-insensitive) and invalid input', async () => {
  await request(app).post('/api/auth/register')
    .send({ name: 'Bob', email: 'bob@example.com', password: 'password123' }).expect(201);
  const dup = await request(app).post('/api/auth/register')
    .send({ name: 'Bob', email: 'BOB@example.com', password: 'password123' }).expect(409);
  assert.match(dup.body.error, /already exists/);

  const bad = await request(app).post('/api/auth/register')
    .send({ name: '<script>', email: 'nope', password: 'short' }).expect(400);
  assert.equal(bad.body.details.length, 3);
});

test('login succeeds with the right password and fails identically otherwise', async () => {
  await request(app).post('/api/auth/register')
    .send({ name: 'Carol', email: 'carol@example.com', password: 'password123' }).expect(201);

  const ok = await request(app).post('/api/auth/login')
    .send({ email: 'CAROL@example.com', password: 'password123' }).expect(200);
  assert.equal(ok.body.email, 'carol@example.com');
  assert.match(ok.headers['set-cookie'][0], /^sid=/);

  const wrong = await request(app).post('/api/auth/login')
    .send({ email: 'carol@example.com', password: 'wrongpass1' }).expect(401);
  const unknown = await request(app).post('/api/auth/login')
    .send({ email: 'nobody@example.com', password: 'password123' }).expect(401);
  assert.deepEqual(wrong.body, unknown.body);
});

test('me returns the signed-in user; logout ends the session', async () => {
  const { agent, user } = await signedInAgent(app);
  const me = await agent.get('/api/auth/me').expect(200);
  assert.equal(me.body.id, user.id);

  await agent.post('/api/auth/logout').expect(204);
  await agent.get('/api/auth/me').expect(401);
});

test('protected routes reject missing, forged and expired sessions', async () => {
  await request(app).get('/api/auth/me').expect(401);
  await request(app).get('/api/notes').set('Cookie', 'sid=forged').expect(401);

  const { agent } = await signedInAgent(app);
  await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
  await agent.get('/api/auth/me').expect(401);
});
