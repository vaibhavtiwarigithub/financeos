# India Live Portfolio: Guardian coverage and recommendation scorecard

Status: **P0 read-only India dashboard implementation**. This extends the existing India Live Portfolio UI without widening broker permissions or creating a new execution path.

## User need

The India Live Portfolio did not show the Manual Trade Guardian or the Recommendations & Guardian scorecard visible in the US Live Portfolio. Reusing the US panels directly would be incorrect: their sources are Robinhood accounts, US Guardian plans, SPY, and a US-only recommendation ledger. India must use Kite and NIFTY 50 and must distinguish an app research observation from a broker order.

## P0 behavior now implemented

### Manual Trade Guardian · India / Kite

- Owner-only `GET /api/live-portfolio/india-guardian` reads current Kite delivery holdings and `GET /gtt/triggers` through the existing `kiteGet` helper.
- Each holding is compared with active same-symbol GTTs. The view reports exact-quantity match, partial quantity, excess quantity, no SELL leg, multiple GTTs needing reconciliation, or unknown when Kite's trigger list cannot be read.
- A two-leg OCO GTT's two children are not summed; their common quantity is compared once with the holding.
- This is **broker-visible GTT coverage**, not the full US Manual Trade Guardian workflow. It does not detect manual fills as events, calculate or propose a stop, create an owner approval plan, place/modify/cancel a GTT, or run an automatic software-stop monitor. Do not call a position protected when Kite's read fails.
- The view warns that Kite GTT children are LIMIT orders and may not fill after a gap through the trigger.

### Recommendations & Guardian scorecard · India

- Owner-only `GET /api/live-portfolio/india-recommendations` reads India's immutable `decision_observations` with `entry_eligible=true` for the last 180 days and joins only already-matured `observation_labels` at horizons 2, 5, 10, and 20.
- The database's benchmark-neutral label is the NIFTY 50 comparison; the route does not import the US `live_recommendations` ledger, `trade_proposals`, SPY marks, or Robinhood position state.
- Aggregate mean excess return and hit rate are descriptive only. These daily decisions overlap, so the UI explicitly says they are not inferential IC/t-stat estimates.
- Recent rows show the frozen composite and dimensions, reference price, matured outcome where available, and whether the symbol is **currently** held in Kite. Current holdings do not establish whether the owner bought and later sold after the recommendation; the UI says so.
- If history exceeds the explicit 2,000-observation read cap, the response flags truncation and the UI warns that aggregates cover only the most recent 2,000 eligible observations. (The P0 response should be extended with a scheduled aggregate producer before anyone treats it as a complete long-run scorecard.)

## Security and execution boundaries

- Both routes require the owner; the service-role database client remains server-only.
- No schema, cron, API-key, feature-flag, paper-trading, or broker-order changes.
- No scores, weights, gates, stops, targets, portfolio positions, or live-trading settings are changed.
- No provider fallback crosses markets. Kite holdings/GTTs are the India broker truth; matured India labels are the outcome source; NIFTY 50 remains the benchmark.

## Verification

- Pure Kite GTT coverage rules have unit tests for full OCO coverage, inactive triggers, partial/excess quantity, conflicting triggers, mismatched OCO legs, and missing SELL orders.
- Required checks: focused test, TypeScript, full test suite, and a read-only owner-page smoke test when authenticated Kite access is available.

## Explicit follow-up, not implied complete

Full India Manual Trade Guardian parity—manual-fill attribution, stop suggestion from the India mandate, an owner-armed plan, alerts/monitoring, and any broker action—needs its own architecture review and explicit approval of the Kite GTT limit-fill risk and exact state machine. P0 is a truthful read-only account-coverage view, not that workflow.
