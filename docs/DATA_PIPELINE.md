# RAVE data pipeline: collection, storage and aggregation

Reflects the code on `main`. Everything below was checked against the real services unless marked (assumed).

## 1. Sources and schedule
All times are UTC. Defined in `backend/src/rave/jobs.js`; run by `scheduler.js`.

| Source | When | What it gives | Notes |
|---|---|---|---|
| ApeWisdom leaderboard | :02 and :32 every hour | Reddit mentions for every stock on the leaderboard (about 820, 9 pages) | Free, no key. The source scans about twice an hour, so more often gains nothing. No history is offered, so RAVE builds its own. 10-minute ticker pages are deliberately NOT scraped. |
| Wikipedia page views | 04:30, 16:30 | Daily views of each company's Wikipedia page (people, not bots) | Wikimedia API, free. 5-year backfill, then a top-up. A day's views appear the next day. |
| Share prices | 12:30, 22:30 | Daily open/close/volume in US dollars for the Reddit stocks and the whole research universe, plus SPY as the market benchmark | Yahoo Finance chart endpoint only (unofficial, free). 5-year backfill, 10-day overlap on each top-up, full refresh weekly (splits). |
| Research universe | daily 03:10, refreshes weekly | S&P 500, 400 and 600 members (about 1,500 US companies) with their Wikipedia articles, when each joined, and the companies that left since 2021 | Wikipedia index lists (`universe.js`). Gives a research sample that does not depend on hindsight; the leavers are kept so results are not flattered by survivors. |
| Company results dates | 02:20, 14:20 | Next announced results date per stock | Yahoo quote-summary calendar (cookie and crumb); each stock re-checked every 5 days; past dates stay, so a real history builds up from 19 Oct 2026. |
| News attention and tone | 06:40, 18:40 | Share of world news mentioning the company and its average tone, per day, for the 300 most talked-about companies | GDELT; one request every 7 seconds (it throttles), so progress is slow and it may fail on some days. Not yet proven useful. |
| Hypothesis tests | 05:15, 23:15 | Wikipedia backtest, strategy lab, forward-ledger outcomes | See METHODOLOGY.md. |

**Scheduler rules.** A job is *due* if it has no successful run since its latest scheduled time, so a restart, deploy or
missed run catches up by itself. Failures retry with backoff (5 min, doubling, up to 1 hour). A run that stopped at its time
limit (`details.partial`, used during the first big Wikipedia and price backfills) continues 5 minutes later instead of waiting
for the next slot. Each job holds a Postgres advisory lock, so two instances never run the same job. State lives in
`collection_runs`. The Data page lists every source and has an "Update now" button (`POST /api/rave/jobs/:kind/run`).

## 2. Reddit collection (`collector.js`, `apewisdom.js`, `store.js`)
- All 9 pages are fetched 750 ms apart; network errors, 429 and 5xx retry 3 times. If ANY page fails the whole run fails and
  saves nothing (a partial leaderboard would make stocks look unranked).
- Names are tidied when read (`text.js`): HTML entities decoded ("S&amp;P" becomes "S&P"), fund-family prefixes dropped.
- Every ticker on the leaderboard is stored. There is no watchlist: all stocks are tracked on equal terms.
- Raw API pages are kept 7 days (`raw_snapshots`) so the integrity check can re-verify stored values.
- Each run stores an md5 fingerprint of all ticker:mentions pairs (`collection_runs.details.fp`); a different fingerprint from the
  previous run means ApeWisdom's numbers actually changed.

## 3. Where data lives (Postgres on Railway, 500 MB volume)
Migrations are in `backend/src/db.js` (append only, run on start).

| Table | Holds |
|---|---|
| `tickers` | latest state per stock: name, rank, mentions, 24h-ago figures, `last_seen` |
| `ticker_days` | ONE row per stock per UTC day with 48 half-hour slots (arrays `mentions`, `ranks`). NULL = no run in that slot; a stock missing from the leaderboard is 0. fillfactor 70. About 220 MB a year for all stocks. |
| `market_days` | per day, per slot: total mentions on the whole leaderboard (marks which slots a run happened in) |
| `collection_runs` | one row per attempt of every job: status, times, `details` JSON, error |
| `raw_snapshots` | untouched API pages, 7 days |
| `wiki_pages` | stock to Wikipedia article match (status, confidence, source auto/override) |
| `wiki_months` | daily page views, one row per article per month (31 slots) |
| `bars`, `price_sync` | daily prices, ONE row per stock with parallel arrays (day number, open, close, volume): about 15 KB for five years, so about 2,500 stocks cost roughly 40 MB; last sync and last error per stock |
| `universe` | research universe members: ticker, name, Wikipedia article, index, sector, added_day, removed_day, active |
| `earnings_dates`, `earnings_checks` | announced company results dates; when each stock was last checked |
| `news_months`, `news_checks` | news volume and tone per stock per month (31 day slots) |
| `validation_runs` | stored hypothesis-test results |
| `spike_events` | forward ledger of Reddit spikes with entry price and 1/5/20-day outcomes |
| `alert_channels` | placeholder for Slack alerts; nothing reads it |
| `users`, `sessions`, `notes` | sign-in and the Notes page |

The old `watchlist` table was dropped (migration 8).

## 4. One company, one row (`share-classes.js`)
Share classes of the same company (GOOGL / GOOG) are merged on the Radar: mentions are added, the first ticker (the "main" one)
carries the Wikipedia page and price, and the other ticker's page opens the same stock. Groups are found by identical company
name on the leaderboard, plus a short list in `share-classes.js` for pairs whose names differ. Research counts one Wikipedia
article once.

## 5. Aggregation (at read time)
`series.js` loads history (last 9 days every 30 minutes, to 40 days hourly, older every 6 hours); `scoring.js` turns it into
scores; `tracked.js` builds the Radar rows (scores, Wikipedia signal, latest price and 1-day / 5-trading-day change) and caches
them until the next Reddit, Wikipedia or price run lands. Scoring all ~820 stocks took about 1.7 s with 30 days of history; it
grows with history, so watch it after a few months (the result is cached, so only the first request after a run pays).

## 6. Integrity checks (`/api/rave/integrity`, Data page)
For the last 48 runs RAVE recomputes what should be stored from the raw pages and compares: rows saved equal rows reported, raw
page and ticker counts, leaderboard total, and every stored mention count and rank. It also reports gaps in the 30-minute
cadence. Runs older than the raw retention are checked for row counts only; runs from the very first layout are flagged legacy.

## 7. Storage and cost
About 220 MB a year for Reddit data, roughly 40 MB for 2 years of prices for ~820 stocks, a few MB for Wikipedia. The Data page
shows database size against the volume. See COSTS_AND_LIMITS.md.

## 8. Confirmed facts about ApeWisdom
- `mentions` is a rolling 24-hour count (equals the sum of its 10-minute buckets exactly, checked on 9 tickers).
- It scans the subreddits about twice an hour; a ticker counts once per post or comment; tickers are detected in capitals or
  with a $ prefix, so ambiguous tickers are noisier.
- The API has no history. Its per-ticker web pages hold about 22 hours of 10-minute buckets, but that is an unofficial page and is not used.
