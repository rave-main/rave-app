# Rebuilding RAVE from scratch

Production was deleted on 2026-10-19 (the owner decided the research found no money-making edge; see HANDOVER.md "Status at wind-down").
The code, tests and all documents stay in the GitHub repo (`main`). This file says what existed and how to bring it back.

## What existed
| Part | Where | Notes |
|---|---|---|
| Repo | GitHub `rave-main/rave-app` (npm workspaces `backend/`, `frontend/`) | CI runs the tests with a Postgres service |
| Backend | Railway project `rave-app` (id `7e022524-78b5-489d-adf9-17103dcb57ab`), service `rave-app-backend` (root `/backend`) | Express; runs migrations at start; scheduler runs inside the process |
| Database | Railway service `Postgres` in the same project | about 30 MB at the end; migrations 1 to 14 |
| Frontend | Vercel project `rave-app` (id `prj_gfij5YPTX5NhhfGAirKmQYlShwHn`, root `frontend`, framework Vite) | `frontend/vercel.json` rewrites `/api/*` to the backend URL |
| URLs (now gone) | https://rave-app-eight.vercel.app and https://rave-app-backend-production.up.railway.app | |
| Other Railway projects (`athletic-education`, `amusing-beauty`) | unrelated; they were left alone | |

## Steps to rebuild (about 30 minutes of clicking, then waiting for data)
1. **Railway:** new project from the GitHub repo, root directory `/backend`; add a PostgreSQL database; set `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `NODE_ENV=production`, `FRONTEND_ORIGIN=<your Vercel URL>` (comma-separated list allowed, wildcards ok for previews), `TRUST_PROXY=2`; generate a public domain. Full table in `SETUP.md`.
2. **Vercel:** import the repo, root directory `frontend`, no environment variables. Edit the destination in `frontend/vercel.json` to the new Railway domain.
3. **Account:** open the site and register (email and password); every `/api/rave/*` endpoint needs a session. Consider closing registration afterwards (`POST /api/auth/register` in `backend/src/auth.js`).
4. **Check:** `GET /api/health`, then `GET /api/rave/sources` for job health.
5. **Backfill (free, automatic; or force each job with `POST /api/rave/jobs/<kind>/run?force=1`):**
   - `apewisdom` every 30 minutes: Reddit mentions. History starts from the day you deploy (ApeWisdom has no usable history; do NOT scrape its 10-minute pages).
   - `wikipedia`: page views, 5 years, resolves articles for tracked tickers.
   - `universe` (weekly): S&P 500/400/600 lists and changes from Wikipedia. The S&P 500 changes table no longer exists on Wikipedia, so S&P 500 leavers are missing.
   - `prices` (Yahoo, 5 years, takes several partial runs of a few minutes each; deploys kill running jobs, then it continues).
   - `earnings` (Yahoo next-earnings dates), `news` (GDELT, weak: about 3 stocks per run), then `lab2` (about 60 to 80 seconds, about 450 MB) and `research`.
6. After the first full `prices` and `lab2` runs the Research page and the per-stock chance of a big move appear.

## What is permanently lost
- Reddit mention history (about 4 weeks at deletion) and the forward ledgers (Reddit and Wikipedia frozen-rule tests). These cannot be rebuilt; a restart begins a new ledger.
- Everything else (prices, Wikipedia views, universe, earnings dates) is re-fetchable from free sources.

## Handy facts
- Railway deploys only after GitHub CI passes (queues can take 20+ minutes); every push restarts the backend and kills running jobs.
- Local development: `SETUP.md`; tests need Postgres (`TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/rave_test`, see `backend/test/create-test-db.sql`).
- Railway free trial ended about 17 Nov 2026; running again costs the $5/month Hobby plan.
- Findings and methods: `WORKLOG.md`, `METHODOLOGY.md`, `docs/signals_check.py`. The literature summary was written outside the repo; ask Claude to regenerate it.
