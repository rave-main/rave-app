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

### 2026-10-18 Accuracy, integrity and cost review (user asked: older data? stored correctly? metrics accurate? costs?)
- VERIFIED: ApeWisdom `mentions` is a rolling 24h count (equals the sum of the 10-minute buckets on its ticker pages,
  exactly, for 9 tickers). ApeWisdom's API has no history; ticker pages embed ~22h of 10-minute buckets (HTML, unofficial).
  Methodology page: scans twice an hour; ticker counted once per post/comment; capitals or $ prefix.
- FOUND (accuracy): at realistic volumes the scoring was weak. 17/day: 8.8 false Rising flags a quarter; below ~8/day
  nearly useless. Cause: spread estimated from 4-8 independent days. Fixed (spread from 28 daily observations,
  Poisson floor, baseline-uncertainty inflation) and added a "Low volume" label. FOUND a second flaw in the market
  adjustment (per-mille share compressed by log1p); now adjusts in mention units. Accuracy table in METHODOLOGY.md.
  Independent Python re-implementation matches the Node scoring exactly (28 numbers).
- BUILT: integrity audit (`/api/rave/integrity`, Data page card). Found and fixed a bug in it via a test (runs whose raw
  data had expired looked like mismatches). Real-data run: collector x2 against live ApeWisdom into a clean DB, all 6
  checks pass on 822 tickers.
- Storage: 249 bytes/row incl. indexes, 450 MB/year; volume is 500 MB. Raw retention cut 30 -> 7 days. Database size
  shown on the Data page (`DB_SIZE_LIMIT_MB` to override the 500).
- UI: rank arrows were backwards (improved rank showed down) - fixed; "vs 24h" shows percent; z-scores shown in words;
  Low volume chip/filter; footnote explaining each column.
- COSTS: docs/COSTS_AND_LIMITS.md. Railway trial 30 days / $5 credit, measured ~$2.2/month, Hobby $5/month after.
- DATA FACT: of 820 tickers only 22 have 17+ mentions/day, 43 have 8+; the whole leaderboard is ~1,900 mentions/day
  (a Sunday; weekdays are probably higher). Four of the ten watchlist stocks are low volume.
- Open decisions for the user: release to main; watchlist (add high-volume names?); whether to also read ApeWisdom's
  10-minute ticker pages (backfill ~22h and repair gaps) given it is an unofficial page; whether to pursue an older-history
  source (Wikipedia pageviews is free/official, daily since 2015; Reddit archives are heavy); upgrade Railway before ~17 Nov.

### 2026-10-18 Release 2: all tickers, scheduler, Wikipedia, prices, hypothesis tests, new UI
- Storage: every ApeWisdom ticker (~820) stored as one row per ticker per UTC day with 48 half-hour slot arrays; ~220 MB/year.
  Tracked set shown on the Radar = watchlist + anything that reached 5 mentions in a day this week.
- Scheduler (`scheduler.js`, `jobs.js`): fixed UTC times, "due" if no success since the last scheduled time, catch-up after
  restarts, failure backoff, per-job advisory locks. ApeWisdom :02/:32; Wikipedia 04:30/16:30; prices 12:30/22:30;
  research 05:15/23:15. No 10-minute scraping.
- Wikipedia page views supplement (never replace) Reddit: automatic article matching (editable in Settings), 5-year backfill,
  same scoring rule, agreement marker when both signals spike.
- Prices: Yahoo Finance only (a second price source was blocked from Railway and later removed), SPY benchmark.
- Hypothesis tests (`validation.js`, `research.js`): event study with placebo-shift null, volatility-matched control, lead-lag,
  verdict levels. The engine was checked on synthetic worlds with known truth; two biases were found and fixed (control
  exclusion; volatility clustering misread as prediction -> "marker" verdict). Reddit is tested forward through a ledger.
- UI: Radar (Wikipedia column, groups, agreement), Stock (Reddit + Wikipedia + price, article editor, past spikes),
  Research, Settings (watchlist, article mapping, Slack placeholder), Data (per-source table with Run now).
- 115 backend tests pass against real Postgres.

### 2026-10-18 Release 3: all stocks, plain language, money, one row per company (user review feedback)
- User feedback implemented: track all ~820 leaderboard stocks (watchlist and controls removed; migration 8 drops the table);
  GOOGL / GOOG shown as one row (`share-classes.js`); names decoded ("S&amp;P" -> "S&P", plus fund-family prefixes dropped);
  Radar shows the ticker only so the whole table fits, with price (US$) and 5-day change columns; Stooq removed (Yahoo only);
  prices backfilled 2 years instead of 5 (storage); plain British English everywhere, short explainers, axis titles with units
  and periods on every chart; Research page rewritten simply (what happened after a spike, gain or loss vs market, $ per $1,000,
  "could it be luck?"), technical detail folded away.
- Scheduler: a job that stops at its time limit (`details.partial`) continues 5 minutes later, so the first Wikipedia and price
  backfills for ~820 stocks finish within an hour or two instead of days. A ticker Yahoo rejects is retried every 3 days, and a
  run only fails if Yahoo itself is failing (10 failures in a row, or nothing fetched).
- Found while changing it: the Wikipedia job's "mostly failing" check counted a list that was capped at 10, so it could never
  trigger at scale. Fixed (`errorCount`).
- Added `docs/HANDOVER.md`: read it first in a new session.

### 2026-10-18 Release 4: Radar filters and cells; strategy research
- Radar: separate Reddit and Wikipedia label filters (with counts), each cell shows rating, measure and change (e.g. Hot 60 -10 (-14%)), sort-by menu,
  fund / word-ticker flags and a funds filter, stars (this browser only), top 10 by mentions, market context line, Wikipedia match counts on the Data page.
  Hand check of 60 random Wikipedia matches: all plausible. Unmatched (354 of 847) are mostly funds and very small companies.
- Research: exported raw data and explored offline in Python. Found and fixed two of my own bugs on the way (feature columns overwritten by future returns
  gave absurd results; caught because the information coefficient was 100%). Result: attention does not predict big swings beyond volatility, spikes are followed by a
  slightly negative average market-adjusted gain, and no rule survives costs and quarters. Implemented as `strategy.js` with synthetic-truth tests; the Research page
  now explains it in three steps. Forward ledgers: Reddit and Wikipedia (frozen rule) as the clean out-of-sample test.
- Incident: a one-line Python helper (`open(p,'w').write(open(p).read()...)`) truncated `rave-research.test.js` to empty and it was committed in e84fc2a, so the
  suite silently ran 8 tests fewer. Restored from history. Lesson: never write helpers that open for writing before reading.

## 2026-10-19: long-horizon lab (lab2) and survivorship
- Added `lab2.js`: weekly rows, 20 and 60 session horizons, market-adjusted labels, stage 1 (big shift or not) and stage 2 (up or down), walk-forward with embargo, long/short deciles after costs, baselines.
- Added point-in-time index membership (`universe.added_day/removed_day`). S&P 400 and 600 changes read from Wikipedia; the S&P 500 page no longer has a changes table, so S&P 500 leavers are missing.
- Result (1,463 stocks, 115 of them leavers with prices; most delisted stocks have no Yahoo history, so some survivorship remains): 20-session score long/short +0.2% per period (CI -0.9% to +1.2%); 60-session +2.3% (CI -1.1% to +5.9%, only 10 non-overlapping periods). Direction AUC at 60 sessions 0.76 (0.72 survivors only), so the leavers did not remove it, but the money result is not significant and low-volatility baselines lost heavily, i.e. a regime effect. Wikipedia attention and earnings add almost nothing to detecting big shifts (stage 1 AUC 0.62 either way). Conclusion: no proven edge; volatility is the usable signal.
- Radar and stock page now show a typical 20-day swing (risk) and a "ran" flag (5-day move already above 1.5x normal).
- Production lab2 job restarts without finishing (probably killed or too slow); results above were produced offline from `/api/rave/export/lab`. Needs a lighter job or a bigger worker.
- Production lab2 now finishes (79 s, 489 MB peak, 1,632 stocks, 170 leavers with prices). With more leavers the 60-session direction AUC fell from 0.76 (offline run, 115 leavers) to 0.68, and the 20-session direction AUC is 0.53: the apparent edge shrinks as survivorship is removed, which is the expected sign of bias. Big-shift detection AUC stays about 0.63.

## 2026-10-19: last bounded test of price-based direction signals (stop rule: test AUC about 0.55 and positive net return)
Single-signal rank tests on the lab panel, test weeks only (last 60% of history), non-overlapping periods, costs 0.32% per leg plus 5% a year borrow. `docs/signals_check.py` reproduces it from the exported panel.
- 4 weeks (31 periods): 1-week reversal AUC 0.487 (net -0.85%), 1-month reversal 0.495, momentum 12-1 0.516 (IC 0.039, t 1.8, net -0.10%), near 52-week high 0.519, volume surge 0.490, low volatility 0.511, small size 0.492. Reversal gated to high market volatility: AUC 0.50.
- 12 weeks (10 periods): all AUC 0.48 to 0.52 except 1-month reversal gated to high market volatility, AUC 0.54, net +2.6% over only 6 periods (t 1.1), the best of 18 variants tried, so not distinguishable from luck.
- Conclusion: none meets the stop rule. Short interest (FINRA) and insider buying (Form 4) were not built: published large-cap effects are tiny (insider about 14 bp) or pre-2010, and the chance of a tradable edge is low.
