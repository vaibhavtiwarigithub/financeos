# India Live Portfolio: Guardian coverage and recommendation scorecard

Status: **P0 read-only India dashboard implementation**. This extends the existing India Live Portfolio UI without widening broker permissions or creating a new execution path.

## User need

The India Live Portfolio did not show the Manual Trade Guardian or the Recommendations & Guardian scorecard visible in the US Live Portfolio. Reusing the US panels directly would be incorrect: their sources are Robinhood accounts, US Guardian plans, SPY, and a US-only recommendation ledger. India must use Kite and NIFTY 50 and must distinguish an app research observation from a broker order.

## P0 behavior now implemented

### Live Portfolio presentation parity (2026-10-19)

- The shared Live Portfolio sequence is Guardian → Recommendations & Guardian scorecard → broker connection/account selector → account statistics → performance chart → holdings. India places its Kite Guardian and India scorecard before the Kite connection summary, matching the US order without merging broker data.
- The India Guardian and scorecard use the same card shell, title treatment, spacing, collapse affordance, KPI strip, filter/sort controls, and desktop-table/mobile-card behavior as the US panels. The data vocabulary remains market-specific (Kite GTT/NIFTY 50 rather than Robinhood Guardian plans/SPY).
- India currently has no persistent recommendation-response ledger. The scorecard therefore labels present-day holding state as “Held now” / “Not held” / “Unknown”; it never represents those states as whether a recommendation was taken. Daily overlapping observation summaries remain descriptive, not IC/t-stat evidence.
- Other portfolio sections remain appropriately market-specific: US account chips/RH transaction import versus India Coin, day positions, and scored Kite order candidates. They use the same top-level shared-section order where a like-for-like section exists; market-exclusive broker data is not fabricated to create visual symmetry.

### Manual Trade Guardian · India / Kite

- Owner-only `GET /api/live-portfolio/india-guardian` reads current Kite delivery holdings and `GET /gtt/triggers` through the existing `kiteGet` helper.
- Each holding is compared with active same-symbol GTTs. The view reports exact-quantity match, partial quantity, excess quantity, no SELL leg, multiple GTTs needing reconciliation, or unknown when Kite's trigger list cannot be read.
- If Kite holdings cannot be read (including an expired daily token), the panel reports holdings as unavailable and gives a Reconnect Kite action; it never displays an empty book as "no holdings" or claims coverage.
- A two-leg OCO GTT's two children are not summed; their common quantity is compared once with the holding.
- This is **broker-visible GTT coverage**, not the full US Manual Trade Guardian workflow. It does not detect manual fills as events, calculate or propose a stop, create an owner approval plan, place/modify/cancel a GTT, or run an automatic software-stop monitor. Do not call a position protected when Kite's read fails.
- The view warns that Kite GTT children are LIMIT orders and may not fill after a gap through the trigger.

### Recommendations & Guardian scorecard · India

- Owner-only `GET /api/live-portfolio/india-recommendations` reads India's immutable `decision_observations` with `entry_eligible=true` for the last 180 days and joins only already-matured `observation_labels` at horizons 2, 5, 10, and 20.
- The database's benchmark-neutral label is the NIFTY 50 comparison; the route does not import the US `live_recommendations` ledger, `trade_proposals`, SPY marks, or Robinhood position state.
- Aggregate mean excess return and hit rate are descriptive only. These daily decisions overlap, so the UI explicitly says they are not inferential IC/t-stat estimates.
- Recent rows show the frozen composite and dimensions, reference price, matured outcome where available, and whether the symbol is **currently** held in Kite. Current holdings do not establish whether the owner bought and later sold after the recommendation; the UI says so.
- The current-holding label is shown only while the Kite holdings read is confirmed; otherwise it says the status is unknown. Hit rates are displayed as ordinary non-negative percentages, separate from signed excess returns.
- If history exceeds the explicit 2,000-observation read cap, the response flags truncation and the UI warns that aggregates cover only the most recent 2,000 eligible observations. (The P0 response should be extended with a scheduled aggregate producer before anyone treats it as a complete long-run scorecard.)

## Security and execution boundaries

### Exact-stop measurement extension (approved 2026-10-22)

Both markets now reuse `GuardianOutcomeScorecard` and the same market-scoped
persisted exact-stop evaluator described in
`features/live-recommendation-tracker/FEATURE_ARCHITECTURE.md`. It compares a
frozen suggested stop with holding over 2/5/10/20 regular sessions. This adds
nullable measurement columns to the existing recommendation tables and extends
the existing nightly job; it does not add an India stop producer or broker path.
India currently has no app-generated suggestions, so this section says so rather
than evaluating Kite GTTs as app advice. The existing India research-label table
and current-holding semantics remain unchanged. The earlier P0 statement that
India does not read recommendation rows applies to that research-label table;
the new exact-stop subsection reads only `market='india'` recommendation rows.
US data is never substituted. The no-schema-change statement below describes
the original P0 only; the approved extension migration is
`20261022214835_guardian_exact_stop_outcomes`.

- Both routes require the owner; the service-role database client remains server-only.
- No schema, cron, API-key, feature-flag, paper-trading, or broker-order changes.
- No scores, weights, gates, stops, targets, portfolio positions, or live-trading settings are changed.
- No provider fallback crosses markets. Kite holdings/GTTs are the India broker truth; matured India labels are the outcome source; NIFTY 50 remains the benchmark.

## Verification

### Source-truth corrections (October 25, 2026)

The read-only Guardian route requires verified holdings and GTT arrays. Missing,
malformed or rejected reads never become empty books: holdings failure returns
503, while a GTT failure preserves valid holdings with unknown protection. The
deduplicated `guardian-coverage:india` health issue persists until both reads pass.
No clock-based expiry clears this issue.

GTT coverage is matched by exchange and symbol. It validates every SELL quantity
and limit price, aligned trigger/order indexes, and a downside SELL trigger
relative to the broker holding's last price. A target-only GTT, missing reference
price, malformed leg or cross-exchange conflict cannot be marked covered. OCO
quantities are compared once, never summed. This is a last-read coverage check,
not a fresh executable quote, guaranteed fill or new stop recommendation.

Broker sync remounts the Guardian check so it is not left on an earlier reading.
Full India stop-suggestion/approval/execution parity remains outside P0.

- Pure Kite GTT coverage rules have unit tests for full OCO coverage, inactive triggers, partial/excess quantity, conflicting triggers, mismatched OCO legs, and missing SELL orders.
- Required checks: focused test, TypeScript, full test suite, and a read-only owner-page smoke test when authenticated Kite access is available.

## Explicit follow-up, not implied complete

Full India Manual Trade Guardian parity—manual-fill attribution, stop suggestion from the India mandate, an owner-armed plan, alerts/monitoring, and any broker action—needs its own architecture review and explicit approval of the Kite GTT limit-fill risk and exact state machine. P0 is a truthful read-only account-coverage view, not that workflow.
