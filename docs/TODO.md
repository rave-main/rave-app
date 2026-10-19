# RAVE TODO (next steps)

## Context
RAVE is live (main = d2e27dd): ~837 Reddit stocks, Wikipedia views as a second signal, Yahoo prices (2 years), Research page, Reddit
forward ledger. You want the Radar tightened first, then the research taken as far as it can go: first understand the big price swings
that follow attention spikes, then see whether they can be split into up and down, and try to find a trading rule that would have made
money historically. Decided: alerts stay in the backlog; Yahoo stays the only price source; Railway stays on the free trial for now
(still ends about 17 Nov 2026, noted in HANDOVER). On approval, also save this as `docs/TODO.md` and link it from `docs/HANDOVER.md`.

## STATUS (2026-10-18)
Part 1 is done (two filters, rating + measure + change cells, fund and word-ticker flags, stars, top 10, market context, Wikipedia match counts). Part 2 stages A to C were done with the strategy lab (see METHODOLOGY.md): no robust profitable rule was found. Still open from Part 2: real earnings dates (fetch from Railway, Yahoo is blocked from the sandbox), Reddit-based tests once there is history, the forward ledgers (running), and a pristine holdout from new data.

## STATUS (2026-10-19, later)
Done: point-in-time S&P 1500 universe (S&P 500 leavers missing: Wikipedia no longer lists them), 5-year prices, lab2 on production (79 s, about 490 MB),
typical 20-day swing, "ran" flag and size idea, chance of a big move per stock with a calibration table, audit duplicate-ticker fix.
Open: (1) Reddit features in lab2 once weeks of history exist; (2) a better free news source than GDELT, or drop it; (3) S&P 500 leavers and prices for the 260
leavers Yahoo does not have (survivorship remains); (4) forward ledgers are the unbiased judge; (5) alerts stay in the backlog.

## Part 1: Radar and product fixes (do first)
1. **Two label filters.** Replace the single "Any label" dropdown with "Reddit: ..." and "Wikipedia: ..." dropdowns (Rising / Hot /
   Extreme / Quiet / Low volume / Warming up), each showing a count, kept in the URL. In `Radar.jsx` filter on
   `r.scores[horizon].label` and `r.wiki.scores[horizon].label`. Test: seed one Hot Reddit stock and one Hot Wikipedia stock and
   check each filter returns only its own.
2. **Source and measure in every cell**, e.g. `Hot · 60 · −10 (−14%)` = label, measure now, change since the comparison point, for
   Reddit (mentions in the last 24 hours, vs 24 hours ago) and for Wikipedia (page views on the latest full day, vs the day before).
   `tracked.js` returns the Wikipedia latest and previous-day views; headings and tooltips say what is counted; one cell per source
   replaces the old Mentions and Change columns; sort by label, measure or % change. Check desktop and phone widths.
3. **Data quality.** Flag stocks / ETFs / ambiguous word-tickers (A, IT, ALL, FOR) and add a filter; sample 50 Wikipedia matches by
   hand, fix the matcher where wrong, and show matched / low-confidence / unmatched counts on the Data page.
4. **Usability.** A personal star list (favourites replace the old watchlist), a "top 10 right now" summary, and a one-line market
   context ("Reddit chatter is X times normal"). Stock page: mark past spikes on the price chart.
5. **Housekeeping.** Frontend smoke test with Playwright in CI; decide to remove or keep the unused `alert_channels` table (alerts
   remain backlog: Slack webhook when rules are decided, max one message per stock per day).

## Part 2: Research (last, and the biggest effort)
What is known: after a Wikipedia spike prices move further than usual but with no consistent direction; in the realistic 2-day-delay
case most of the extra size is explained by the stock already being jumpy; average market-adjusted gain about +0.1% over 5 days.
Method rules for everything below: choose the splits and strategy rules BEFORE looking at results, keep the last 6 months as a test
set that is looked at once, count how many variants were tried and correct for it, and include costs. A rule that only works on the
data it was found on is a failure, and the Research page will say so.

**Stage A: understand the big swings (size).**
1. Add earnings dates (free source; check Yahoo and Nasdaq calendars) plus splits and index changes. Re-run the event study with
   scheduled-event windows excluded, and separately for spikes right before earnings. This may explain most of the size effect.
2. Describe the swings: size by horizon (1, 5, 20 days), by stock type (price band, ETF vs company, dollar volume), by strength
   (Hot vs Extreme), by Reddit and Wikipedia agreeing, and by market regime (SPY trend and volatility). Find where the extra move is
   largest and most reliable. Use all 837 stocks, not only those with Wikipedia pages, where Reddit history allows.
3. Check timing: day-0 and day-1 price move relative to the spike day, to see whether the move has already happened by the time the
   spike is visible (Wikipedia is a day late; Reddit, going forward, is not).

**Stage B: split big swings into up and down.**
4. Look for predictors of direction inside the spike events: price change over the prior 5 and 20 days (momentum vs reversal),
   whether the spike day itself was up or down, distance from the 52-week high or low, gap at the open, volume surge, Reddit rank change,
   Reddit upvotes per mention. Fit simple, transparent rules first (single splits, then a small decision tree or logistic regression with
   cross-validation by time), not black boxes.
5. Cross-sectional version: each day rank all stocks by attention change and compare top and bottom groups over 5 and 20 trading days
   (long-short and market-neutral). More data than rare events.
6. Fade versions: avoid or short after Extreme spikes over 20 to 60 days; buy after a spike plus a pullback.

**Stage C: turn what survives into a strategy and test it.**
7. Backtest engine on historical prices with clear rules (entry at the next open after the signal, fixed hold, equal weight, max
   positions, stop optional), costs of 0.1 to 0.5% per trade by liquidity bucket, dollar volume filter, and results in US$ per $1,000:
   total return, drawdown, hit rate, and the equity curve against SPY. Walk-forward (train on early, test on later) and the held-out
   6 months.
8. Straddle-style use of size: if direction cannot be predicted, report an "expected move" risk indicator on the Radar instead of a
   buy signal.
9. Write up honestly on the Research page: what works, what does not, how many things were tried, out-of-sample results. If nothing
   survives costs and the held-out test, say "attention is a risk signal, not a buy signal" and keep the Reddit forward ledger as the
   unbiased judge (30 spikes minimum, 100+ preferred).

## Verification
Backend `npm test` (about 2.5 minutes, run in the background) plus new tests; frontend build; Playwright check of the live site at
1200px and 390px (no overflow or console errors, units on every number); for research, synthetic-world tests first (the method must
recover known effects and find nothing in pure noise, including for the new direction splits and backtest), then regenerate
`/api/rave/research`, record results, caveats and number of variants tried in `docs/WORKLOG.md`, and update METHODOLOGY and HANDOVER.
