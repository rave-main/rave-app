# RAVE handover: read this first

For a new Claude session (or person) picking this up. Last updated 2026-10-19.

**Next steps are in [TODO.md](TODO.md).**

## STATUS AT WIND-DOWN (2026-10-19)
The project was paused here on purpose. Everything is committed and on `main` (and the working branch `claude/loving-fermi-cq6r5e`); nothing is half-done.
- **Built and working:** Reddit and Wikipedia collection, S&P 1500 point-in-time universe, 5-year compact prices, earnings dates, Radar with typical 20-day swing, "ran" flag and size idea, per-stock chance of a big move with calibration, long-horizon lab (`lab2.js`), forward ledgers.
- **Research verdict:** no reliable money-making edge found. Big moves in size can be ranked (test AUC about 0.67 at 4 weeks and 0.71 at 12 weeks) but a single volatility number does the same; direction is near chance once survivorship bias is removed (test AUC 0.53 at 4 weeks); price-based signals (reversal, momentum, 52-week high, low volatility, volatility-gated reversal) all fail a stop rule of about 0.55 AUC and positive net return. See `WORKLOG.md` (2026-10-19 entries), `METHODOLOGY.md` (lab section) and the literature summary (`Predictors of stock return direction.md`, kept outside the repo: ask for it to be regenerated if lost).
- **Not tried (would need new data):** FINRA short interest, SEC Form 4 insider buys, a better free news source than GDELT, S&P 500 leavers (Wikipedia no longer lists them), real historical earnings dates.
- **Forward ledgers** (Reddit and Wikipedia, frozen rules) are the only unbiased test of attention; they only grow while collection runs. Reddit attention features cannot enter the lab until weeks of ApeWisdom history exist.
- **To resume:** read this file, `TODO.md` and `WORKLOG.md`; start Postgres for tests (see "How to run and test"); check `GET /api/rave/sources` for job health; the Railway trial ends about 17 Nov 2026, after which collection stops unless the Hobby plan is taken.

## What RAVE is
**RAVE = Retail Attention Volatility Engine.** It tracks how much small investors talk about every US stock on Reddit
(via ApeWisdom) and how many people view each company's Wikipedia page, flags unusual surges with an explainable score, shows
them on a sortable Radar with share prices (US$), and tests with price data whether a surge comes before price moves
("is there time to act?"). Wikipedia SUPPLEMENTS Reddit; it never replaces it. It is a research tool, not investment advice.
The owner is not an investment expert: wording must stay simple, in British English, with units (US$, %, periods) on every number and chart.

## Where things are
- Repo `rave-main/rave-app` (npm workspaces: `backend/`, `frontend/`). Develop on a branch; the user has allowed pushing to
  `main` on request. CI (GitHub Actions, Postgres service) runs the tests; Railway deploys the backend only after CI passes;
  Vercel deploys the frontend (`frontend/`), rewriting `/api/*` to Railway.
- Production: https://rave-app-eight.vercel.app (frontend), https://rave-app-backend-production.up.railway.app (backend).
- Railway and Vercel API access comes from the sandbox proxy (no keys needed); GitHub access is through the GitHub tools.
  Railway trial ends about **17 Nov 2026**: it needs the $5 Hobby plan or collection stops.
- Sign-in is email and password; the site is private. Every `/api/rave/*` endpoint needs a session.

## Code map (backend/src/rave)
| File | Job |
|---|---|
| `jobs.js`, `scheduler.js` | the four scheduled jobs and the due-based scheduler (partial runs continue after 5 min) |
| `apewisdom.js`, `collector.js`, `store.js` | fetch the Reddit leaderboard, store it compactly (48 half-hour slots per stock per day) |
| `text.js` | name tidying (HTML entities, fund prefixes) |
| `share-classes.js` | merges GOOGL / GOOG style pairs into one stock |
| `series.js`, `scoring.js` | build series; scores (times normal, how unusual, label) for 3 horizons |
| `tracked.js` | every stock with Reddit score, Wikipedia signal, price; cached per run |
| `wiki.js`, `wikijob.js` | match stocks to Wikipedia pages, daily page views |
| `prices.js`, `pricejob.js` | Yahoo prices (only source), compact `bars` storage, 5-year backfill, SPY benchmark |
| `universe.js` | S&P 500/400/600 members, joiners and leavers from Wikipedia |
| `earnings.js` | upcoming results dates from Yahoo (cookie + crumb) |
| `news.js` | GDELT news volume and tone |
| `export.js` | paged raw data for offline research (`/api/rave/export/lab`) |
| `validation.js`, `research.js` | event study, lead-lag, verdicts; Wikipedia backtest; forward ledgers (Reddit and Wikipedia, `spike_events.source`) |
| `strategy.js` | strategy lab: what drives big swings, up or down, rule backtests with costs and a holdout |
| `stock-kind.js` | company / fund / ambiguous-word ticker flag |
| `audit.js`, `diagnostics.js` | integrity re-check; probes of each external source |
| `router.js` | all `/api/rave/*` endpoints |
Frontend (`frontend/src`): `Radar.jsx`, `Stock.jsx`, `Research.jsx`, `Data` (`DataHealth.jsx`), `Settings.jsx`, shared `lib.jsx`, styles `App.css`.
Offline research: `GET /api/rave/export/backtest?offset=&limit=` pages out raw Wikipedia views and prices; the exploration was done in Python (pandas) on that.
Docs: `METHODOLOGY.md` (the maths), `DATA_PIPELINE.md` (sources, tables, schedule), `COSTS_AND_LIMITS.md`, `WORKLOG.md` (history, newest last).

## Decisions and why
- ApeWisdom only for Reddit (reliable, free); 30-minute cadence because it scans about twice an hour. NEVER scrape its 10-minute pages (user decision).
- All ~820 leaderboard stocks tracked equally; quiet ones are labelled Low volume, not hidden. No watchlist.
- Wikipedia added as a second signal because it has years of history (Reddit has none); Reddit is tested going forward via the ledger.
- Prices 2 years for every stock (storage); Yahoo only (a second source was blocked from Railway).
- Research verdict is deliberately conservative: a volatility-matched control stops "already volatile" being read as "attention predicts".
  First real result: realistic entry = "not a useful signal on its own"; optimistic = bigger moves, no direction.
- Alerts: Slack is a disabled placeholder card and an unused `alert_channels` table. Not implemented on purpose.
- Compact storage + fillfactor 70 keeps all stocks at about 220 MB a year.

## How to run and test
```bash
npm install
# tests need Postgres; in the cloud sandbox one was started on port 5433:
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/rave_test npm test      # about 2.5 minutes, 110+ tests
npm run build --workspace frontend                                           # or: cd frontend && npm run build
```
Locally: `docker`/`npm run db:up`, `npm run dev` (see README). Set `RAVE_COLLECTOR=off` to stop scheduled jobs on a second instance.
Seed helper for tests: `seedHistory` in `backend/test/helpers.js`; synthetic worlds for the statistics in `backend/test/validation-world.js`.

## Gotchas
- A deploy restarts the backend and kills any job mid-run. Jobs resume by themselves (abandoned at boot, partial runs continue after 5 minutes), but a manual run does not. Do not push while a long backfill you started by hand is running.
- GitHub Actions can queue for a long time; Railway deploys only after CI passes, so a push may take 5 to 30 minutes to go live.
- The cloud sandbox cannot reach Yahoo, Wikipedia, GDELT and similar. Anything needing them must run on Railway (add a probe in `diagnostics.js`, read it at `/api/rave/diagnostics?candidates=N`).
- Do not lose research to survivorship: a universe made of today's index members or today's popular stocks flatters anything that rewards winners. Use the membership dates (`universe.added_day`, `removed_day`).
- Never run `pkill -f` from the tool shell (it kills its own shell); find the pid instead.
- Run long test commands in the background; the shell has a 280-second command limit.
- Yahoo can block or throttle: check the Data page. The first backfill for ~820 stocks takes a few runs (it continues every 5 minutes by itself).
- Scoring ~820 stocks was 1.7 s with 30 days of history and grows with history; cached per run. If it becomes slow, cache in the background.
- Wikipedia matches are heuristic: the Settings page lists "needs checking" ones; manual choices are never overwritten.
- Migrations are append-only in `backend/src/db.js`.

## Open risks / next steps
1. Railway trial end (about 17 Nov 2026).
2. Yahoo is a single unofficial source of prices.
3. Research results are only as good as the history: Reddit needs 30 spikes with 5-day outcomes (weeks) before any conclusion.
4. Selection bias: the tested stocks are the ones popular today.
5. Possible next features: Slack alerts, background refresh of scores, rolling old Reddit readings to hourly, a backup/export of the database.
