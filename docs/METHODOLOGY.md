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
**Verified:** ApeWisdom `mentions` is a rolling 24-hour count. Its per-ticker pages publish the underlying counts per
10 minutes, and their sum over 24 hours equals the leaderboard figure exactly (checked on 9 tickers, 2026-10-18).
Each point therefore covers a whole day, with no hour-of-day effect. A stock is compared only with its own history.
Two views are computed for every horizon:
- raw mentions, and
- mentions adjusted to a typical-sized market day (each point scaled by baseline-median leaderboard total / that
  point's leaderboard total), which cancels market-wide waves. Labels use the adjusted view when totals are known.

| Horizon | Current | Baseline (centre) | Needs |
|---|---|---|---|
| Short | the latest 24h count | the same weekday and hour over the previous up-to-8 weeks once 4+ weeks exist, otherwise all points from the previous 7 days | 2+ days of baseline (otherwise "Warming up", using ApeWisdom's own 24h-ago number) |
| Medium | median of the last 7 daily values | up to 84 daily values before that (12 weeks) | 5+ current and 28+ baseline days |
| Long | median of the last 28 daily values | all earlier daily values (up to 730) | 20+ current and 28+ baseline days |

- `ratio` = current / baseline median ("3.2x normal").
- `z` = (log(1 + current) - median of log(1 + baseline)) / (scale x inflate), where
  - **scale** = max(robust spread, 0.05, 1/sqrt(typical count + 1)). The robust spread (1.4826 x MAD) is estimated from
    up to 28 once-a-day observations (rolling 24h windows a day apart do not overlap), NOT from the baseline points,
    which overlap heavily and would understate the noise. The 1/sqrt(count) floor is the Poisson noise inherent to
    small counts.
  - **inflate** = sqrt(1 + 1.57 / days in the baseline), because the centre is itself only estimated from that many days.
- Labels, strictest first: Extreme ratio >= 3 and z >= 4; Hot ratio >= 2 and z >= 3; Rising ratio >= 1.5 and
  z >= 2; otherwise Quiet. Never flagged below 10 mentions per 24h. **Low volume**: a stock that typically gets fewer
  than 5 mentions a day and is below 10 now is labelled Low volume (not rated) instead of a falsely reassuring Quiet.
  Short horizon only: a Hot/Extreme reading is capped at Rising (`unconfirmed`) unless the snapshot at least
  20 minutes earlier was already at Rising level.
- Confidence (high/medium/low) reflects how much of the intended baseline exists; the short horizon is at most
  "medium" until the same-weekday baseline exists (4+ weeks).
- Every score carries a plain-English explanation. Thresholds and windows are in `CONFIG` (versioned).

### Accuracy (simulated Poisson counts with day-to-day variation and quieter weekends; 6 seeds x 125 days, 100 trials)
| Mentions per day | False "Rising or above" per quarter | False "Hot or above" per quarter | 3x surge caught as Hot+ | 3x as Rising+ |
|---|---|---|---|---|
| 100 | 0.2 | 0 | 100% | 100% |
| 45 | 1.0 | 0 | 100% | 100% |
| 17 | 2.4 | 0 | 77% | 99% |
| 8 | 0.7 | 0 | 19% | 74% |
| 4 | 0.2 | 0 | 0% | 35% |
| 1-2 | ~0 | 0 | ~0% | ~0-6% |
Reading it: at the volumes of the 3 busiest stocks the method is reliable; around 17 a day a sustained tripling is
usually caught; below about 8 a day the data cannot support confident flags, which is why those stocks are
labelled Low volume. Before this study the 17-a-day case had 8.8 false Rising flags a quarter (the spread was
estimated from only 4-8 independent days); the fix is described above. A second flaw found at the same time: the
market adjustment used "mentions per 1000" which the log scale compresses for quiet stocks; it now stays in
mention units.
These are tests of the METHOD on synthetic data. Whether real attention behaves like the simulator is checked as
real data arrives.
**Independent check:** the same numbers were recomputed by a separate Python implementation written from this
document; all 28 compared values (ratio and z, raw and adjusted, all horizons) matched exactly.
