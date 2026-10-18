const request = require('supertest');
const { createApp } = require('../src/app');
const { createPool, migrate } = require('../src/db');

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/rave_test';

async function setup() {
  const pool = createPool(TEST_DB);
  await migrate(pool);
  await pool.query('TRUNCATE users, sessions, notes RESTART IDENTITY CASCADE');
  const app = createApp({ pool, frontendOrigin: 'https://app.example,https://*-team.vercel.app' });
  return { pool, app };
}

// Registers a user and returns a supertest agent that carries their session cookie
async function signedInAgent(app, overrides = {}) {
  const agent = request.agent(app);
  const user = { name: 'Test User', email: `user${Math.random().toString(36).slice(2)}@example.com`, password: 'correct horse battery', ...overrides };
  const res = await agent.post('/api/auth/register').send(user).expect(201);
  return { agent, user: res.body, password: user.password };
}

module.exports = { setup, signedInAgent, request };
