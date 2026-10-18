# RAVE data pipeline: collection, aggregation and storage

Reflects the code on branch `claude/loving-fermi-cq6r5e`. Items marked (live) are confirmed on the real service.

## 1. Collection
- **Source:** ApeWisdom `all-stocks` leaderboard, `https://apewisdom.io/api/v1.0/filter/all-stocks/page/N`. Free, no key.
  Reddit stock-mention counts. (live) 820 tickers over 9 pages of 100; per ticker: `rank`, `ticker`, `name`,
  `mentions`, `upvotes`, `rank_24h_ago`, `mentions_24h_ago`. Whole leaderboard takes about 9 s to fetch.
- **Who collects:** the Node backend on Railway (`backend/src/rave/collector.js`), the same process that serves the
  API. No GitHub Actions, no Python, no external scheduler.
- **When:** first run 5 s after the backend boots, then every 30 min plus 0-5 min random jitter. A restart or
  overlapping deploy skips if a successful run exists from the last 10 min. A Postgres advisory lock (key 727275)
  means two instances can never collect at once.
- **How:** all pages are fetched one after another (750 ms apart, 15 s timeout). Network errors, HTTP 429 and 5xx are
  retried 3 times (1 s, 3 s, 9 s). Other 4xx responses and non-JSON bodies fail immediately. If ANY page cannot be
  fetched, the whole run fails and saves nothing: a partial leaderboard would make watchlist stocks look unranked.
  The response shape is validated (numbers may arrive as strings or numbers; both are handled).
- **Failure handling:** a failed run is recorded with its error and the previous data stays as it was. A run
  interrupted mid-way (process killed during a deploy) is marked failed ("abandoned") by the next run after 15 min.
- **Not built yet:** repairing a missed 30-minute slot (a short deploy gap loses that snapshot). Planned for milestone 5.

## 2. What is kept from each collection run
One collection run = one timestamp (`fetched_at` = when the run started). From the 820 tickers RAVE stores:
- every **watchlist** ticker (8 hype stocks + 2 controls). One missing from the leaderboard is stored as
  `mentions = 0`, `ranked = false`, shown as "not on leaderboard", never as a silent zero;
- the **top 100** tickers of the leaderboard (for a future "Discover" view);
- the **market total** = sum of mentions over ALL tickers on the leaderboard (including the ones not stored),
  saved on the run. It is the denominator for the market-adjusted ("share") view.
That is about 103 snapshot rows per run, about 4,900 a day, about 1.8 million a year.
The raw API responses (all pages) are also kept for 7 days: (live) about 112 KB of JSON per run, about 76 KB as stored
(compressed), so roughly 26 MB at steady state. They exist so stored values can be re-verified (see Integrity below).

## 3. Where it is stored
Postgres, in the Railway project `rave-app` (service `Postgres`, with a persistent volume, reachable only on
Railway's private network). Only the backend can read or write it; the website reaches data solely through the
sign-in protected `/api/rave/*` endpoints. Tables (migrations in `backend/src/db.js`, run automatically on start):

| Table | One row per | Holds | Kept |
|---|---|---|---|
| `watchlist` | tracked stock | ticker, name, is_control, active | permanent, editable |
| `collection_runs` | collection attempt | status (running/success/failed), start/finish, pages fetched/total, tickers seen, rows written, market total mentions, error text | permanent |
| `snapshots` | stock per run | ticker, fetched_at, ranked, rank, mentions, upvotes, rank_24h_ago, mentions_24h_ago. Unique on (source, ticker, fetched_at) | permanent |
| `raw_snapshots` | page per run | the untouched JSON page | 7 days, then deleted |

A run's raw pages, snapshot rows and its final status are written in ONE database transaction, so a run is either
fully saved or not saved at all. Not stored: tickers outside the top 100 that are not on the watchlist (only counted in
the market total), and no prices yet (milestone 3).
No backup or export routine has been set up. The volume survives deploys, but a backup is a sensible later step.

## 4. Aggregation (at read time; nothing is pre-aggregated yet)
- Snapshots are stored exactly as received. Everything below is computed when a page is requested, from the stored rows.
- `backend/src/rave/series.js` loads each stock's history: the last 9 days at full resolution (about every 30 min) and
  anything older reduced to one point per hour. The market total is joined in from `collection_runs`.
- `backend/src/rave/scoring.js` turns that series into the short/medium/long scores (see METHODOLOGY.md): raw mentions
  and the stock's share of all chatter (mentions per 1000 leaderboard mentions), compared with the stock's own history.
- "Data changed" on the Data page: an md5 fingerprint of all stored (ticker:mentions) pairs per run, compared with
  the previous SUCCESSFUL run. Different = ApeWisdom's numbers changed; the same = RAVE checked but nothing moved.
- Sparklines (last 48 points), day-over-day (ApeWisdom's own 24h-ago figure) and the status/freshness figures are
  also computed per request. Rollups or caching are planned before a year of data accumulates (milestone 5).

## 5. Integrity checks (`/api/rave/integrity`, shown on the Data page)
For the last 48 successful runs RAVE re-derives what should be stored from the raw responses and compares: rows saved
equal rows reported; every watchlist stock present in every run; raw pages and ticker counts equal what the run
reported; the stored leaderboard total equals the sum of raw mentions; every stored mention count and rank equals the
raw response. It also reports gaps in the 30-minute cadence. Verified on real data (2 live runs, 822 tickers: all pass)
and with tests that corrupt each kind of value and confirm it is caught. Runs older than the raw retention are
checked for row counts only.

## 6. Storage growth
Measured: about 249 bytes per `snapshots` row including indexes (21,130 rows = 5.1 MB), 103 rows per run, 48 runs a day:
about 1.2 MB a day, 450 MB a year. With 7 days of raw data (~26 MB) and Postgres's own ~84 MB, a 500 MB volume lasts
roughly 10-11 months. The Data page shows database size against the volume. Levers if needed: a bigger volume (paid
plan), storing the top 100 less often than every run, or rolling old rows up to hourly.

## 7. What is confirmed vs assumed
- (verified 2026-10-18) `mentions` is a rolling 24-hour count: it equals the sum of ApeWisdom's 10-minute buckets over
  24 hours for GME, NVDA, TSLA, MSFT, AAPL, PLTR, HOOD, SOFI, AMC exactly.
- ApeWisdom's methodology page says it scans the subreddits twice an hour; a ticker counts once per post or comment
  even if named several times; tickers are detected when written in capitals or with a $ prefix (so ambiguous
  tickers such as common words are noisier); only tickers listed on its sister site are shown.
- (live) The first production run saved 816 tickers / 103 rows; the source's top-100 changed between samples 3 minutes apart.
- ApeWisdom's API has NO history. Its per-ticker web pages embed about 22 hours of 10-minute buckets; that is an
  unofficial page (robots.txt only disallows /gotopage/; no terms page found), not an API.

## 8. Sources and schedule (v2)
| Source | When (UTC) | Notes |
|---|---|---|
| ApeWisdom leaderboard | :02 and :32 every hour | all ~820 tickers, one slot of 48 per day; no 10-minute scraping |
| Wikipedia page views | 04:30, 16:30 | 5-year backfill, then top-up |
| Prices (Yahoo) | 12:30, 22:30 | 5-year backfill, 10-day overlap top-up, weekly full refresh |
| Hypothesis tests | 05:15, 23:15 | backtest plus forward-ledger outcomes |
A job is due if it has no success since its latest scheduled time, so restarts and deploys catch up. Failures back off, and
per-job advisory locks stop overlaps. State is in `collection_runs`; the Data page lists each source with Run now.
Storage: one row per ticker per UTC day with 48 half-hour arrays (about 220 MB a year for all tickers).
