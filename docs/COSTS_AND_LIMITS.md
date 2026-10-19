# Costs and limits (checked 2026-10-18)

| Service | Plan / limit | Cost now | What to watch |
|---|---|---|---|
| Railway (backend + Postgres) | Hobby **trial: 30 days or $5 credit**; Postgres volume **500 MB** | measured about **$2.2 a month** | **The trial ends about 17 Nov 2026.** After that the Hobby plan is $5 a month (includes $5 of usage), so expect about $5 a month. If the trial ends without a paid plan the services stop and collection stops (a gap in the history). |
| Vercel (frontend + /api proxy) | Hobby, free, personal non-commercial use | $0 | Far below the free quotas. Commercial use needs a paid plan. |
| GitHub (repo, CI) | public repo | $0 | Actions minutes are free for public repos. |
| ApeWisdom | free, no key, no uptime promise | $0 | 9 requests every 30 minutes (about 430 a day). It could change or disappear. |
| Wikipedia / Wikimedia | free, no key, needs a descriptive user agent | $0 | About one request per stock per run during the first backfill, then one per stock per day. |
| Yahoo Finance prices | free, unofficial, the ONLY price source | $0 | About one request per stock per run, spaced 400 ms. Yahoo can throttle or change without notice; if it fails, price data stops updating (the Data page shows it). A stock Yahoo rejects is retried every 3 days. |

## Storage (500 MB volume)
- Reddit data for all ~820 stocks: about 220 MB a year.
- Prices: 5 years for about 2,500 stocks in the compact `bars` layout, about 40 MB (the earlier row-per-day layout would have needed over 150 MB). Wikipedia views: a few MB. Raw API pages (7 days): about 26 MB.
- So the volume lasts a little over a year with everything on. The Data page shows usage. If it gets tight: a bigger volume,
  or roll old Reddit readings up to hourly.

## Adding stocks
Costs nothing on the Reddit side (every run already downloads the whole leaderboard). Each stock adds about one price request
and one Wikipedia request per day.

## Update 2026-10-19
- New free sources: Wikipedia index lists (membership), Yahoo quote-summary (results dates, needs a cookie and crumb), GDELT (news tone, throttled to one request every 5 seconds and sometimes unreachable). None needs a key.
- Database was 28 MB on 19 Oct after moving prices to the compact layout; with the 5-year backfill for the whole universe it is expected to stay well under 150 MB.
- Not reachable from the cloud sandbox I develop in (but reachable from Railway): Yahoo, Wikipedia, Wikimedia, GDELT, ApeWisdom. Blocked from both: SEC EDGAR (403), Nasdaq calendar, Stooq. Reddit archive search (Arctic Shift) times out on text queries, so Reddit history cannot be rebuilt that way.
