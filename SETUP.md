# Setup & Deployment

Production runs on two services, both deploying automatically from `main`:

| Part     | Host    | URL |
|----------|---------|-----|
| Frontend | Vercel project `rave-app` (root directory `frontend`) | https://rave-app-eight.vercel.app |
| Backend  | Railway project `rave-app`, service `rave-app-backend` (root directory `/backend`) | https://rave-app-backend-production.up.railway.app |
| Database | Railway project `rave-app`, service `Postgres` (private network only) | — |

## Backend (Railway)

Service variables on `rave-app-backend`:

| Variable          | Value |
|-------------------|-------|
| `DATABASE_URL`    | `${{Postgres.DATABASE_URL}}` (reference to the Postgres service) |
| `NODE_ENV`        | `production` (makes the session cookie `Secure`) |
| `FRONTEND_ORIGIN` | `https://rave-app-eight.vercel.app,https://*-rave-ecf1.vercel.app` (production + previews) |
| `TRUST_PROXY`     | Number of proxy hops in front of the app, so rate limits see the real client IP |

Railway injects `PORT`. Migrations run on every start, so a deploy with a new migration upgrades the schema.

To set up from scratch: create a project from the GitHub repo with root directory `/backend`, add a Postgres
database (**+ New → Database → PostgreSQL**), set the variables above, and generate a domain under
**Settings → Networking**.

## Frontend (Vercel)

The Vercel project is linked to `rave-main/rave-app` through the Vercel GitHub App, with root directory `frontend`.
Pushes to `main` deploy to production; pushes to other branches get preview deployments.

The frontend needs no environment variables. `frontend/vercel.json` rewrites `/api/*` to the Railway backend, so
the browser only talks to the Vercel domain. If the backend URL changes, update that rewrite.

## Verify

```bash
SITE=https://rave-app-eight.vercel.app
curl $SITE/api/health                      # {"status":"ok","database":"ok",...}
curl -i $SITE/api/auth/me                  # 401 when signed out
```
Open the site, create an account, add a note, reload: the note should still be there.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "API offline" | Check `/api/health` on the Vercel URL and the Railway deploy logs |
| `/api/health` returns `503` | The backend can't reach Postgres: check `DATABASE_URL` and the Postgres service |
| `403 Origin not allowed` | The page's origin isn't in `FRONTEND_ORIGIN` |
| Signed out after every reload locally | Use http://localhost:5173 (not 127.0.0.1) so the Vite proxy and cookie line up |
| `429 Too many requests` | Rate limit; wait a minute (15 minutes for sign-in attempts) |
| `413 Payload too large` | Request body is over 10KB |
