# rave-app

A fullstack starter: an **Express API** (`backend/`) and a **React + Vite** frontend (`frontend/`), managed as npm workspaces.

## Quick start

```bash
npm install
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
npm run dev          # API on :3000, frontend on :5173
```

## API

| Method | Path              | Description                                  |
|--------|-------------------|----------------------------------------------|
| GET    | `/health`         | `{"status":"ok","timestamp":"..."}`          |
| GET    | `/api/users`      | All users                                    |
| GET    | `/api/users/:id`  | One user, or `404`                           |
| POST   | `/api/users`      | Create user `{ name, email }` → `201`        |
| GET    | `/api/analytics`  | 7 days of `{ date, users, pageViews, bounceRate }` |

Data is in-memory dummy data; it resets on every restart.

### Security
- CORS restricted to `FRONTEND_ORIGIN` (comma-separated list)
- Rate limit: 100 requests/min per IP (`429` when exceeded)
- JSON body limit: 1KB (`413` when exceeded)
- Input validation; names/emails containing markup characters are rejected (XSS protection)
- `helmet` security headers

## Deployment
Frontend → Vercel, backend → Render. See [SETUP.md](SETUP.md).
