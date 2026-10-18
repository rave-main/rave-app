const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, signedInAgent, request } = require('./helpers');

let pool, app;
before(async () => ({ pool, app } = await setup()));
after(() => pool.end());

test('requires sign-in', async () => {
  await request(app).get('/api/notes').expect(401);
  await request(app).post('/api/notes').send({ title: 'x' }).expect(401);
});

test('create, list, update and delete a note', async () => {
  const { agent } = await signedInAgent(app);

  const created = await agent.post('/api/notes').send({ title: ' First ', body: 'Hello' }).expect(201);
  assert.equal(created.body.title, 'First');
  assert.equal(created.body.body, 'Hello');

  const list = await agent.get('/api/notes').expect(200);
  assert.equal(list.body.length, 1);

  const updated = await agent.patch(`/api/notes/${created.body.id}`).send({ body: 'Changed' }).expect(200);
  assert.equal(updated.body.title, 'First');
  assert.equal(updated.body.body, 'Changed');

  await agent.delete(`/api/notes/${created.body.id}`).expect(204);
  await agent.delete(`/api/notes/${created.body.id}`).expect(404);
  assert.equal((await agent.get('/api/notes').expect(200)).body.length, 0);
});

test('users cannot see or change each other\'s notes', async () => {
  const alice = await signedInAgent(app);
  const bob = await signedInAgent(app);
  const note = await alice.agent.post('/api/notes').send({ title: 'Private' }).expect(201);

  assert.equal((await bob.agent.get('/api/notes').expect(200)).body.length, 0);
  await bob.agent.patch(`/api/notes/${note.body.id}`).send({ title: 'Hacked' }).expect(404);
  await bob.agent.delete(`/api/notes/${note.body.id}`).expect(404);
  assert.equal((await alice.agent.get('/api/notes').expect(200)).body[0].title, 'Private');
});

test('validates input and ids', async () => {
  const { agent } = await signedInAgent(app);
  await agent.post('/api/notes').send({ title: '' }).expect(400);
  await agent.post('/api/notes').send({ title: 'x', body: 'y'.repeat(5001) }).expect(400);
  await agent.patch('/api/notes/1').send({}).expect(400);
  await agent.patch('/api/notes/abc').send({ title: 'x' }).expect(400);
  await agent.delete('/api/notes/99999999999').expect(400);
});

test('notes are deleted with their user', async () => {
  const { agent, user } = await signedInAgent(app);
  await agent.post('/api/notes').send({ title: 'Gone soon' }).expect(201);
  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM notes WHERE user_id = $1', [user.id]);
  assert.equal(rows[0].n, 0);
});
