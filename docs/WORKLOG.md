# RAVE work log

Append-only record of what was done, decided and found, newest at the bottom. If a session dies, resume from the
last entry. The approved plan lives in the session that created it; the essentials are repeated here.

## Plan in one paragraph
RAVE (Retail Attention Volatility Engine) tracks Reddit stock-mention counts from ApeWisdom (the only attention
source, by the user's choice), collected every ~30 min by the Railway backend into Postgres. It scores abnormal
attention per stock over short/medium/long horizons with an explainable robust ratio + z-score, shows it on a
Radar/Stock/Compare/Research UI, and validates against daily prices whether attention leads price. Alerts are a
Slack placeholder only (nothing is sent). Rules: work on branch `claude/loving-fermi-cq6r5e`; nothing reaches
`main` without the user's approval, except ONE approved early release of the additive backend after milestone 1.

Milestones: 1 foundations+ApeWisdom collector, 2 scoring, 3 prices+validation+forward ledger, 4 UI,
5 hardening. Stop and ask the user if: ApeWisdom fails or changes shape; a step needs spend; targets cannot be
met after repeated attempts; results show no signal.

## Log

### 2026-10-18 Plan approved, milestone 1 started
- Environment: apewisdom.io is blocked by this container's network policy, so the adapter is built from the
  documented response shape (`count`, `pages`, `current_page`, `results[]` with `rank`, `ticker`, `name`,
  `mentions`, `upvotes`, `rank_24h_ago`, `mentions_24h_ago`; numbers may be strings) and tested with fixtures.
  Live verification happens from Railway (collector logs and /api/rave/status).
- Decision: raw API responses are kept for 30 days (parsed rows are the permanent record) to limit database size.
- Decision: a run that cannot fetch EVERY page fails instead of writing a partial leaderboard, because a partial
  leaderboard would make watchlist stocks look "not ranked" and corrupt the baseline.

### 2026-10-18 Milestone 1 built (branch, not yet released)
- Added migration 2 (watchlist seeded with GME, AMC, PLTR, SOFI, RIVN, NVDA, TSLA, HOOD + controls AAPL, MSFT;
  collection_runs, raw_snapshots, snapshots), `backend/src/rave/{apewisdom,collector,router}.js`, wiring in
  `app.js` / `server.js`, and docs. Collector: advisory-lock lease, skips if a success is < 10 min old, marks
  abandoned runs failed, all-or-nothing transaction per run, 30-day raw retention, ~30 min + jitter schedule,
  first run 5 s after boot, clean SIGTERM.
- API (sign-in required): GET /api/rave/watchlist, /stocks (latest snapshot per stock), /status (freshness,
  last runs, history length).
- Tests: 19 new (parsing/retry/shape errors, success/failure/rollback/lock/skip/abandoned/pruning, API). 34 pass.
- End to end against a local fake ApeWisdom (set `APEWISDOM_BASE_URL=http://127.0.0.1:4010/api/v1.0`;
  fake is a ~10 line server returning 2 pages with string numbers): 150 tickers, 106 rows written, missing
  watchlist stocks stored ranked=false; a restart inside 10 min was skipped; SIGTERM exited 0.
- NOT yet verified: the real apewisdom.io response (blocked from this container). First proof will be the
  collector log and /api/rave/status on Railway after the early release.
- Test gotcha: user names containing digits are rejected by validation (use e.g. "Test Person").
- Next: CI, then the approved early release of this additive backend to main, then verify on production.

### 2026-10-18 Early release BLOCKED, continuing on the branch
- Milestone 1 is on the branch at 7af7f07 and CI is green on that exact commit (34 backend tests).
- `git push origin HEAD:main` (the one early release approved in the plan) was denied by the session's auto-mode
  permission classifier as a "Production Deploy". Not worked around. Needs the user to either do the push / merge
  themselves, or add a permission rule that allows pushing to main, or tell me another route (e.g. a pull request
  they merge). Until then NO RAVE data is being collected (collection only runs in production).
- Continuing with milestone 2 (scoring) on the branch, which does not depend on the release.
- Assumption to verify on real data once collecting: ApeWisdom `mentions` is a rolling 24-hour count, so
  mentions at time t should be close to `mentions_24h_ago` at t + 24h. Scoring is designed around that.
