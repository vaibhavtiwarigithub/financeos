# Hybrid Protective Stops

> Status: DRAFT, design only. Not approved for implementation. Money path.
> Scope: US and India live positions. Paper remains unchanged unless separately approved.

## Decision

Kairos currently owns close-based stop, target, trailing, thesis, and time exits. A
broker-hosted order changes an analytical close-based rule into an intraday-touch
execution rule. That is a strategy change, not merely outage protection.

The recommended design is therefore a **wider disaster floor**, not a duplicate
of the analytical stop:

- Kairos remains authoritative for analytical exits and the trailing ratchet.
- The broker holds a wider, static protective floor for app or scheduler outages.
- Broker fills are reconciled back into the Performance Truth Layer.
- A broker floor may only move upward and may never increase risk.

Do not build until the owner explicitly approves touch semantics, floor distance,
and post-fill protection policy.

## Verified Broker Capabilities

| Broker | Verified capability | Constraint | Design consequence |
|---|---|---|---|
| Kite | GTT `single`/`two-leg` trigger with child orders represented as `LIMIT` | A trigger creates a limit order; a gap can leave it unfilled. GTT can be modified with `PUT` and returns an expiry. | Use a stop-limit disaster floor, modify in place, and surface unfilled-trigger risk. |
| Kite regular order | `MARKET`, `LIMIT`, `SL`, `SL-M`; DAY/IOC/TTL validity | A regular protective order is not a multi-day substitute for GTT. | Do not renew DAY stops as hidden cron state. |
| Robinhood agent API | Existing captured tool schema is insufficient proof for a new stop integration | Public support pages do not define Kairos's current MCP order arguments. | Require a fresh live `tools/list` schema capture before implementation. |
| Webull | Trading API documents stop orders; Cloud MCP is query-only | Trading API is a different signed integration. Trailing-stop orders are DAY-only in the documented stock API. | Out of scope; never infer MCP writes. |

## Required State Model

One authoritative `protective_order` record per live position and broker:

- `position_id`, `broker_account_id`, `market`, `symbol`
- `broker_order_id` or Kite `trigger_id`
- `mode = disaster_floor`
- analytical stop, broker floor, trigger and limit prices
- status: `placing`, `active`, `triggered`, `filled`, `canceling`, `canceled`, `failed`, `needs_reconcile`
- broker version/update timestamp, expiry, last reconciliation timestamp
- immutable reason and correlation/idempotency id

The record references the existing position and execution ledger. It must not
create a parallel position, cash, or P&L truth layer.

## Execution Protocol

### Entry

1. Pass all existing money-path gates and place the live BUY.
2. Reconcile the BUY fill and held quantity.
3. Compute a deterministic disaster floor from the approved mandate.
4. Reserve one protective-order intent using a stable idempotency key.
5. Place the broker floor and persist its broker id and expiry.
6. If placement or persistence fails, create a critical health issue and mark the
   position unprotected. The owner must decide whether further live entries halt.

### Ratchet

- Only update when the approved floor has risen by the minimum step.
- Kite uses modify-in-place for the existing GTT where possible.
- Any cancel/replace broker must confirm cancellation before replacement.
- Never lower a floor and never leave two sell orders capable of exceeding the
  reconciled holding.

### Explicit Exit

1. Read and lock the current protective-order state.
2. Cancel the resting protection and confirm cancellation.
3. Re-read reconciled held quantity.
4. Submit a SELL no larger than that quantity.
5. If cancellation cannot be confirmed, fail closed and alert. Do not submit a
   competing SELL that could create an accidental short.

The current standalone Kite path rejects a partial explicit SELL when a resting
GTT exists because it cannot atomically rebuild protection for the residual.

The standalone Kite route now follows this cancel-before-sell rule; a future
shared implementation must reuse the protocol rather than add a second path.

### Reconciliation

Every live snapshot must detect out-of-band triggers, partial fills, cancellations,
expiry, and broker-side edits. Reconciliation closes or adjusts the Kairos position
using actual fills and appends execution evidence. Unknown state is
`needs_reconcile`, never assumed active or canceled.

## Safety Invariants

- No LLM computes, places, modifies, or cancels protection.
- US and India accounts, cash, orders, and quantities never cross.
- Existing pause, market controls, kill switch, drawdown breaker, approval mode,
  notional limits, and account allowlist all remain upstream.
- Total executable SELL quantity can never exceed reconciled held quantity.
- A trigger without a confirmed fill does not close the book.
- A gap through a Kite limit child is reported as unprotected, not called filled.
- Expired protection is a critical health state.
- Paper and live outcomes are not mixed across different exit semantics.

## Acceptance Tests

1. A cancel failure prevents the explicit SELL.
2. A replace cannot create two executable protective orders.
3. A falling high-water mark cannot lower the floor.
4. A Kite trigger with no fill remains open/unprotected and raises an issue.
5. An out-of-band fill reconciles with actual quantity and price.
6. Partial fills leave the correct residual protection.
7. Expiry and broker-side cancellation are detected.
8. Every pause/kill/account/approval gate blocks entry and protection writes.
9. US and India fixtures cannot read or mutate the other market.
10. Paper results remain on their existing close-based semantics.

## Open Owner Decisions

1. Approve broker-hosted touch execution at all?
2. Disaster-floor distance: fixed percentage beyond analytical stop, volatility
   multiple, or mandate-specific value? Recommendation: mandate-specific ATR rule
   with a hard maximum loss bound.
3. Does an unprotected post-fill position halt all new live entries for that market?
   Recommendation: yes, while existing exits remain enabled.
4. Minimum ratchet step and update cadence.
5. Whether paper receives a separately versioned touch-fill simulation before live.

## Build Order After Approval

1. Capture current broker schemas and write failure-injection contract tests.
2. Add protective-order state and reconciliation without placing orders.
3. Shadow the computed floor and broker capability status.
4. Implement Kite sandbox/manual path first.
5. Implement a verified Robinhood path only after live schema capture.
6. Run a single owner-approved small live test per market.
7. Keep Webull in its separate feature and disabled.
