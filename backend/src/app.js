const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { authRouter, requireAuth, wrap } = require('./auth');
const { notesRouter } = require('./notes');

// FRONTEND_ORIGIN is a comma-separated list; an entry may use one * wildcard in the host,
// e.g. https://*-rave-ecf1.vercel.app to allow Vercel preview deployments
function originMatcher(list) {
  const patterns = list
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      if (o === '*') return /^.*$/;
      const escaped = o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('*', '[a-z0-9-]+');
      return new RegExp(`^${escaped}$`);
    });
  return (origin) => patterns.some((re) => re.test(origin));
}

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

function createApp({ pool, frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173' }) {
  const app = express();
  const isAllowedOrigin = originMatcher(frontendOrigin);

  // ---------- Security middleware ----------
  app.disable('x-powered-by');
  // Hops of trusted proxies in front of the app (Railway's edge, plus Vercel's when proxied)
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // Allow same-origin and non-browser requests (curl, health checks), which send no Origin
        if (!origin || isAllowedOrigin(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS'));
      },
      credentials: true,
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
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());

  // ---------- Routes ----------
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/api/health', wrap(async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'ok', timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'unreachable', timestamp: new Date().toISOString() });
    }
  }));

  app.use('/api/auth', authRouter(pool));
  app.use('/api/notes', requireAuth(pool), notesRouter(pool));
  app.get('/api/analytics', requireAuth(pool), (req, res) => res.json(analytics));

  // ---------- 404 + error handling ----------
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Payload too large (max 10KB)' });
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

  return app;
}

module.exports = { createApp, originMatcher };
