# RAVE methodology

Status: milestone 1. Scoring, validation and the alert interface are added as they are built.

## Data
- Source: ApeWisdom `all-stocks` leaderboard (Reddit stock subreddits). Each snapshot gives, per ticker, `rank`,
  `mentions`, `upvotes`, `rank_24h_ago`, `mentions_24h_ago`. It is a snapshot API with no history, so RAVE builds
  its own history by collecting about every 30 minutes. There is no backfill.
- A watchlist ticker that is not on the leaderboard is stored with `mentions = 0` and `ranked = false`, and shown
  as "not on leaderboard" rather than as a real zero.
- Every run is recorded in `collection_runs`. Raw responses are kept 30 days; parsed rows are permanent.
- Reddit chatter is a different signal from Google searches, and conclusions only apply to the former.

## Scoring (v1, `backend/src/rave/scoring.js`)
ApeWisdom `mentions` is a rolling 24-hour count (to be verified on real data: mentions at t should be close to
`mentions_24h_ago` at t + 24h), so each point already covers a whole day. A stock is compared only with its own
history, so there is no cross-stock scaling problem. Two views are computed for every horizon:
- raw mentions, and
- the stock's share of all leaderboard chatter (mentions per 1000 leaderboard mentions), which removes
  market-wide waves. Labels use the share view when the market total is known.

| Horizon | Current | Baseline | Needs |
|---|---|---|---|
| Short | the latest 24h count | the same weekday and hour over the previous up-to-8 weeks once 4+ weeks exist, otherwise all points from the previous 7 days | 2+ days of baseline (otherwise "Warming up" using ApeWisdom's own 24h-ago number) |
| Medium | median of the last 7 daily values | up to 84 daily values before that (12 weeks) | 5+ current and 28+ baseline days |
| Long | median of the last 28 daily values | all earlier daily values (up to 730) | 20+ current and 28+ baseline days |

- `ratio` = current / baseline median ("3.2x normal"). `z` = robust z-score on log(1 + x): (current - median) /
  (1.4826 x MAD), with the spread floored at 0.05 so a flat history cannot make z explode.
- Labels (strictest first): Extreme ratio >= 3 and z >= 4; Hot ratio >= 2 and z >= 3; Rising ratio >= 1.5 and
  z >= 2; otherwise Quiet. Never flagged below 10 mentions per 24h. Short horizon only: a Hot/Extreme reading is
  capped at Rising (`unconfirmed`) unless the snapshot at least 20 minutes earlier was already at Rising level.
- Confidence: high / medium / low from how much of the intended baseline exists. The short horizon is at most
  "medium" until the weekday-and-hour baseline exists.
- Every score carries a plain-English explanation with the numbers. Thresholds and windows are in `CONFIG`
  (versioned); a change is a new version so earlier results stay reproducible.

Verified with a simulator that produces ApeWisdom-like data (hourly counts, weekday pattern, persistent daily
noise, rolling 24h sum): a sustained 3x surge is Hot or Extreme in at least 90% of 100 trials; a 2x surge is at
least Rising in at least 90%; pure noise gives at most about one Hot-or-above episode per stock per quarter; a
market-wide doubling does not flag (adjusted view) while the raw view still shows it. These are tests of the
method on synthetic data; whether real attention behaves like the simulator is checked as real data arrives.
