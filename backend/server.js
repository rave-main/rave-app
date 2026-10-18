require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// ---------- Security middleware ----------
app.disable('x-powered-by');
app.set('trust proxy', 1); // correct client IPs behind Render/Railway/Vercel proxies
app.use(helmet());
app.use(
  cors({
    origin(origin, cb) {
      // Allow non-browser clients (curl, health checks) that send no Origin
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error('Not allowed by CORS'));
    },
  })
);
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again in a minute.' },
  })
);
app.use(express.json({ limit: '1kb' }));

// ---------- Helpers ----------
const EMAIL_RE = /^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]{2,}$/;
// XSS protection: reject markup characters outright rather than storing escaped text
const NAME_RE = /^[\p{L}\p{M}' .-]+$/u;

function validateUser(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Request body must be a JSON object'];
  }
  const { name, email } = body;
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 50) {
    errors.push('name must be a string of 2-50 characters');
  } else if (!NAME_RE.test(name.trim())) {
    errors.push('name may only contain letters, spaces, apostrophes, periods and hyphens');
  }
  if (typeof email !== 'string' || email.length > 100 || !EMAIL_RE.test(email.trim())) {
    errors.push('email must be a valid email address');
  }
  return errors;
}

// ---------- Dummy data ----------
const users = [
  { id: 1, name: 'Alice Johnson', email: 'alice@example.com', joined: '2026-01-15' },
  { id: 2, name: 'Bob Smith', email: 'bob@example.com', joined: '2026-03-22' },
  { id: 3, name: 'Carol Davis', email: 'carol@example.com', joined: '2026-06-08' },
];
let nextId = users.length + 1;

const analytics = Array.from({ length: 7 }, (_, i) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (6 - i));
  return {
    date: d.toISOString().slice(0, 10),
    users: [120, 135, 128, 150, 162, 158, 175][i],
    pageViews: [480, 530, 510, 600, 655, 640, 710][i],
    bounceRate: [42.1, 40.5, 41.8, 38.2, 37.5, 39.0, 36.4][i],
  };
});

// ---------- Routes ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/users', (req, res) => {
  res.json(users);
});

app.get('/api/users/:id', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }
  const user = users.find((u) => u.id === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.post('/api/users', (req, res) => {
  const errors = validateUser(req.body);
  if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

  const email = req.body.email.trim().toLowerCase();
  if (users.some((u) => u.email === email)) {
    return res.status(409).json({ error: 'A user with that email already exists' });
  }
  const user = {
    id: nextId++,
    name: req.body.name.trim().replace(/\s+/g, ' '),
    email,
    joined: new Date().toISOString().slice(0, 10),
  };
  users.push(user);
  res.status(201).json(user);
});

app.get('/api/analytics', (req, res) => {
  res.json(analytics);
});

// ---------- 404 + error handling ----------
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large (max 1KB)' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON' });
  }
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`rave-app API listening on port ${PORT}`);
    console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
  });
}

module.exports = app;
