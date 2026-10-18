# Costs and limits (checked 2026-10-18)

| Service | Plan / limit | Cost now | What to watch |
|---|---|---|---|
| Railway (backend + Postgres) | Hobby **trial: 30 days or $5 credit** (workspace reports 30 days left, $4.996 credit left); Postgres volume **500 MB** | measured about **$2.2 a month** (spend rose $0.00042 in 8.3 minutes) | The trial ends about 17 Nov 2026. After that the Hobby plan is $5 a month and includes $5 of usage, so expect about $5 a month total. If the trial ends without a paid plan the services stop and collection stops (a gap in the history). Volume: 84 MB used, grows about 450 MB a year, see docs/DATA_PIPELINE.md section 6. |
| Vercel (frontend + /api proxy) | Hobby, free, for personal non-commercial use | $0 | Far below the free quotas (a browser tab makes about 3 requests a minute). Commercial use needs a paid plan. |
| GitHub (repo, CI) | public repo | $0 | Actions minutes are free for public repos. |
| ApeWisdom | free, no key, no documented rate limit, no uptime promise, run by a small company | $0 | RAVE makes 9 requests every ~30 minutes (about 430 a day). The source scans only twice an hour, so fetching more often gains nothing. It is unofficial in the sense of having no guarantee: it could change or disappear. |
| Price data (milestone 3, not built) | Yahoo chart endpoint / Stooq, free and unofficial | $0 | Unverified, to be tested before relying on it. |

Adding stocks costs nothing on the collection side: every run already downloads all ~820 tickers. Each extra
watchlist stock adds 48 rows a day (about 12 KB a day, 4 MB a year) unless it is already in the stored top 100.
Price data adds a few requests per stock per day.
