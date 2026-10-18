# rave-app

A fullstack app: an **Express API** with **Postgres** (`backend/`) and a **React + Vite** frontend (`frontend/`),
managed as npm workspaces. Users sign up with email and password and keep private notes.

## Quick start

Needs Node 22+ and Docker (for the local database).

```bash
npm install
npm run db:up                                   # Postgres on :5432 (rave_dev + rave_test databases)
cp backend/.env.example backend/.env
npm run dev                                     # API on :3000, frontend on http://localhost:5173
npm test                                        # backend tests against rave_test
```

The frontend always calls the API at `/api` on its own origin: Vite proxies it to `localhost:3000` in development,
and Vercel rewrites it to the Railway backend in production (`frontend/vercel.json`). That keeps the session cookie
first-party in every environment.

## API

| Method | Path                 | Auth | Description                                         |
|--------|----------------------|------|-----------------------------------------------------|
| GET    | `/health`            |      | Liveness: `{"status":"ok",...}`                     |
| GET    | `/api/health`        |      | Liveness plus database check (`503` if DB is down)  |
| POST   | `/api/auth/register` |      | `{ name, email, password }` → `201` + session cookie |
| POST   | `/api/auth/login`    |      | `{ email, password }` → `200` + session cookie       |
| POST   | `/api/auth/logout`   |      | Ends the session → `204`                            |
| GET    | `/api/auth/me`       | ✓    | The signed-in user, or `401`                        |
| GET    | `/api/notes`         | ✓    | Your notes, newest first                            |
| POST   | `/api/notes`         | ✓    | `{ title, body? }` → `201`                          |
| PATCH  | `/api/notes/:id`     | ✓    | `{ title?, body? }` → `200`, or `404`               |
| DELETE | `/api/notes/:id`     | ✓    | `204`, or `404`                                     |
| GET    | `/api/analytics`     | ✓    | 7 days of dummy `{ date, users, pageViews, bounceRate }` |

Data lives in Postgres. The schema is created and upgraded automatically on startup by the migrations in
`backend/src/db.js` (append new ones to the list; never edit old ones).

### Security
- Passwords hashed with bcrypt (cost 12); login responses don't reveal whether an email exists
- Sessions: random tokens in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production), stored hashed in
  Postgres, expire after 30 days, revoked on sign-out
- Every notes query is scoped to the signed-in user
- CORS restricted to `FRONTEND_ORIGIN` (comma-separated; one `*` wildcard allowed in the host)
- Rate limits: 100 requests/min per IP overall, 20 sign-up/sign-in attempts per 15 min per IP
- JSON body limit 10KB; input validation; names containing markup are rejected; `helmet` security headers

## Workflow

1. Work on a branch; run `npm test` and try it locally with `npm run dev`.
2. Push the branch: GitHub Actions runs the tests and build, and Vercel posts a preview URL for the frontend
   (previews talk to the production API).
3. Merge to `main`: Vercel deploys the frontend and Railway deploys the backend automatically.

See [SETUP.md](SETUP.md) for how the hosting is configured.
