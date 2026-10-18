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
