const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { validateRegistration, validateLogin } = require('./validate');

const COOKIE_NAME = 'sid';
const SESSION_DAYS = 30;
const BCRYPT_ROUNDS = 12;
// Compared against when the email is unknown, so login takes the same time either way
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, createdAt: u.created_at });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  };
}

async function startSession(pool, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), userId, SESSION_DAYS]
  );
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

// Attaches req.user when the session cookie is valid; otherwise responds 401
function requireAuth(pool) {
  return wrap(async (req, res, next) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'Not signed in' });
    const { rows } = await pool.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)]
    );
    if (!rows.length) {
      res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
      return res.status(401).json({ error: 'Not signed in' });
    }
    req.user = rows[0];
    next();
  });
}

function authRouter(pool) {
  const router = express.Router();

  // Stricter limit on credential endpoints to slow down password guessing
  const credentialLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.AUTH_RATE_LIMIT) || 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts, please try again later.' },
  });

  router.post('/register', credentialLimiter, wrap(async (req, res) => {
    const errors = validateRegistration(req.body);
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

    const name = req.body.name.trim().replace(/\s+/g, ' ');
    const email = req.body.email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(req.body.password, BCRYPT_ROUNDS);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING RETURNING *`,
      [name, email, passwordHash]
    );
    if (!rows.length) return res.status(409).json({ error: 'An account with that email already exists' });

    await startSession(pool, res, rows[0].id);
    res.status(201).json(publicUser(rows[0]));
  }));

  router.post('/login', credentialLimiter, wrap(async (req, res) => {
    const errors = validateLogin(req.body);
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

    const email = req.body.email.trim().toLowerCase();
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const ok = await bcrypt.compare(req.body.password, rows[0]?.password_hash || DUMMY_HASH);
    if (!rows.length || !ok) return res.status(401).json({ error: 'Incorrect email or password' });

    await pool.query('DELETE FROM sessions WHERE user_id = $1 AND expires_at <= now()', [rows[0].id]);
    await startSession(pool, res, rows[0].id);
    res.json(publicUser(rows[0]));
  }));

  router.post('/logout', wrap(async (req, res) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
    res.status(204).end();
  }));

  router.get('/me', requireAuth(pool), (req, res) => res.json(publicUser(req.user)));

  return router;
}

module.exports = { authRouter, requireAuth, wrap };
