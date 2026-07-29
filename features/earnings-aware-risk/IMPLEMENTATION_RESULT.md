# Earnings-Aware Risk P0 Implementation Result

Date: 2026-07-29
Status: Complete and deployed to production schema
Policy: `v1`, `shadow` only

## Shipped

- Source-aware US earnings resolution across the existing PIT calendar,
  Finnhub, Webull, and Robinhood; India uses its market-local calendar/Yahoo
  source. A disagreement beyond one market session is `conflict`.
- Robinhood read-only contract allowlist and owner/cron schema diagnostics.
  Order, review, cancel, account, and position tools are structurally excluded.
- Exact post-event expiry, bounded option-instrument pagination, nearest common
  call/put strike, timestamp/liquidity/spread validation, and an expiry-bounded
  ATM straddle move proxy. Yahoo is a labelled fail-soft shadow fallback.
- Paper entry and capital-rotation annotations before execution. The annotation
  cannot alter the atomic fill or rotation arguments.
- Live proposal annotation while preserving the existing Alpha Vantage
  `-2/+5` blackout exactly. No live execution code reads the annotation.
- Owner-facing Portfolio Risk panel with current-holding event warnings and
  acceptance-window counts. No raw option chain reaches the browser.
- Append-only `earnings_risk_observations` with owner-read RLS, service-only
  insert, immutable rows, retry idempotency, and database checks that pin
  `policy_mode='shadow'` and `behavior_changed=false`.
- Post-DDL advisor findings were resolved: the owner policy caches `auth.jwt()`
  through a scalar subquery and `proposal_id` has a covering partial index.

## Live Proof

The bounded AAPL probe on 2026-07-29 resolved the same 2026-07-30 AMC date from
the cache, Finnhub, Webull, and verified Robinhood calendar. It selected the
2026-07-31 expiry and the true $340 common strike, then normalized timestamped
Robinhood bid/ask, sizes, and open interest. The quote exceeded the 15-minute
freshness ceiling and was correctly classified `stale`; no counterfactual action
was treated as usable. Retrying the probe left one ledger row.

## Behavior Boundary

This release does not change scores, eligibility, sizing, stops, targets,
holding horizons, proposals, fills, rotations, or exits. Future activation
requires 60 otherwise-eligible US entry decisions, 20 distinct events, the
remaining calibration gates in `FEATURE_ARCHITECTURE.md`, and a separate owner
approval.
