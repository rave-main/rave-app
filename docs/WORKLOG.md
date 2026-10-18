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

### 2026-10-18 Milestone 2 (scoring) built on the branch
- `rave/stats.js` (median, scaled MAD), `rave/scoring.js` (v1; see docs/METHODOLOGY.md), `rave/series.js`
  (loads recent data at full resolution, older hourly), `/api/rave/stocks` now returns `scores` per stock.
- Tests: 16 scoring tests with a synthetic simulator (`test/rave-sim.js`) + 1 API test. 50 backend tests pass.
  Targets met: 3x surge detected >= 90% (100 trials), 2x >= Rising >= 90%, noise <= ~1 false Hot+ episode per
  stock-quarter, market-wide wave not flagged.
- Found and fixed while testing: the short horizon claimed "high" confidence with only 7 days of baseline; now
  capped at "medium". A test that expected tiny counts to stay Quiet failed because the simulator produced exactly
  10 mentions (the minLevel); rewrote it as an explicit boundary test (8 -> Quiet, 12 -> flagged).
- Open: minLevel (10) and all thresholds are starting points chosen before seeing real data; revisit after the
  first weeks of collection (check the leaderboard's typical counts for the watchlist stocks, e.g. AAPL/MSFT).
- Open: /api/rave/stocks recomputes scores per request from raw history; fine now, add daily rollups/caching in
  milestone 5 before a year of data accumulates.
- Next: milestone 3 (prices + validation harness + forward ledger). BLOCKED on nothing technical, but the early
  release to main is still pending the user's decision, so no real data is accumulating yet.

### 2026-10-18 Released to main (user approved); FIRST REAL DATA
- Pushed 9a4272a to main (user explicitly approved after the first denial). Railway deployed it on Node 22,
  waiting for CI first as configured.
- First real collector run (log line 17:19:08 UTC): `success`, 9 of 9 pages, 816 tickers, 103 rows written,
  not truncated, market total 1,867 mentions. /api/rave/status (signed in) agrees; stale=false.
- Watchlist on the real leaderboard (mentions in 24h / 24h earlier; rank): NVDA 45/76 #3, GME 17/6 #21,
  TSLA 18/74 #18, MSFT 29/24 #12, AAPL 8/25 #38, PLTR 8/14 #41, HOOD 5/7 #59, SOFI 2/1 #116, AMC 1/4 #581,
  RIVN 1/2 #644. All ten were present, so none was stored as unranked.
- FINDING: counts are small. Average is ~2 mentions per ticker; even NVDA at #3 has 45. The minLevel of 10
  means AMC, RIVN, SOFI, HOOD, PLTR, AAPL cannot be flagged today. Log-scale z-scores on counts of 1-5 will be
  noisy (Poisson noise dominates). To revisit once there are a few weeks of real data: minLevel, a
  Poisson-aware spread floor, and whether medium/long (which average days) should carry the signal for
  low-volume names. The synthetic tests used levels around 100/day and do NOT cover this regime.
- Still to verify on real data: that `mentions` is a rolling 24h count (mentions at t vs mentions_24h_ago at
  t+24h); collection cadence and gaps over several runs; the numbers against the apewisdom.io website.

### 2026-10-18 Verified against the live service; UI built (branch, NOT yet released)
- apewisdom.io allowed by the user. Ran the real adapter from this container (needs `NODE_USE_ENV_PROXY=1`, as Node's
  built-in fetch ignores the sandbox proxy; Railway needs nothing): 820 tickers, 9/9 pages, 8.6 s, no duplicates
  (the 816 vs 820 earlier was new tickers appearing between fetches). Shape matches the docs; numbers are real numbers.
- Refresh probe (page 1 every 3 min): top-100 fingerprint changed 17:25 -> 17:31 (NVDA/GME/MU unchanged), so the
  source updates within minutes. Raw payload is 112 KB per run (about 5 MB/day, 150 MB at 30 days).
- Backend: `/api/rave/runs`, `/api/rave/stocks/:ticker`, status extras (`lastChangeAt`, `unchangedRuns`,
  `expectedIntervalMinutes`, server `now`), `/stocks` gains `spark` and `dayOverDay`. Found and fixed: the "data changed"
  comparison used the previous run even if it failed; now compares with the previous successful run. 54 tests pass.
- Frontend: react-router + recharts (chart pages lazy-loaded). Header freshness pill (Live/Delayed/Stale, polls every
  30 s, flashes "New data" on a new run), Radar (sort/filter/horizon/search in the URL, movers, sparklines), Data page
  (run chart + table, changed vs same numbers), Stock page (history chart, three score explanations). Removed the demo
  analytics screen; Notes stays under its own tab.
- Browser-tested against a local stack seeded with 45 days of SIMULATED history (seed script lived in the scratchpad):
  sorting, filters, horizon switch, unknown ticker, mobile width, no page errors. Gotchas: an old Vite on :5173 held the
  port (kill by pid, never `pkill -f` from the tool shell: it matches its own command line and kills it, exit 144);
  Recharts animations made screenshots show half-drawn charts (animations off).
- Added docs/DATA_PIPELINE.md (collection, storage, aggregation).
- PENDING USER DECISION: release this to main. Previews and the live site depend on the new backend endpoints.
