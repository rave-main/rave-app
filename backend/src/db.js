const { Pool } = require('pg');

// Each migration runs once, in order, inside a transaction. Append new ones; never edit old ones.
const migrations = [
  `CREATE TABLE users (
     id SERIAL PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE TABLE sessions (
     id SERIAL PRIMARY KEY,
     token_hash TEXT NOT NULL UNIQUE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX sessions_user_id_idx ON sessions(user_id);
   CREATE TABLE notes (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     body TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX notes_user_id_idx ON notes(user_id);`,
];

function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new Pool({ connectionString, max: 10 });
}

async function migrate(pool) {
  const client = await pool.connect();
  try {
    // Serialise concurrent boots (e.g. overlapping deploys) on an advisory lock
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
    const { rows } = await client.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
    for (let v = rows[0].v + 1; v <= migrations.length; v++) {
      await client.query('BEGIN');
      try {
        await client.query(migrations[v - 1]);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

module.exports = { createPool, migrate };
