# Hybrid Protective Stops

> Status: DRAFT, design only. Not approved for implementation. Money path.
> Scope: US and India live positions. Paper remains unchanged unless separately approved.

## Shadow scaffold status (2026-07-18)

The owner approved BUILDING the shadow scaffold — everything UP TO the placement
line, and it STOPS there. **No live broker order is placed. Not a $1 test. Ever.**
The spec below remains authoritative for the eventual live design; this section
records what shipped as inert scaffolding.

**Built (all shadow / no placement), under `lib/protective/`:**

- `capabilities.ts` — the broker-neutral `BrokerProtectiveCapabilities` matrix +
  `evaluateProtection()` (capability-driven; no flat broker boolean; no eligible
  multi-day order → `unprotected-by-broker`; GTC ≠ every-session triggering).
- `kite-capabilities.ts` — Kite's capability declared from the PROVEN GTT code
  (`gtt_limit` weaker protection; DAY-only SL-M rejected as a multi-day floor).
- `disaster-floor.ts` — pure `computeDisasterFloor({mode, distance, …})`. Default
  `mode = wider_disaster_floor` (Q1 unanswered); distance is a config input, no
  hardcoded value; monotonic ratchet (a falling high-water mark can't lower it).
- `reconcile.ts` — pure `reconcileProtectiveOrder()` (out-of-band triggers,
  partial fills, cancels, expiry, broker edits, corp-action drift; unknown →
  `needs_reconcile`; trigger-without-fill never closes the book).
- `state.ts` — the `protective_order` record shape + status machine + exit
  provenance (`protective_disaster_floor` / `learning_scope = risk_policy_only`)
  + long-only / cancel-before-replace invariants.
- `placement-gate.ts` — **THE MONEY LINE.** False-by-default
  `protective_orders_enabled` flag gates ALL placement and stays false;
  `planProtectivePlacement()` never calls a broker.

**Migration (PROPOSAL — not applied):**
`supabase/migrations/20260718000000_protective_orders_shadow.sql`.

**Tests:** `tests/protective-hybrid-stop.test.ts` — all 14 spec acceptance tests,
each falsifiable (mutation-verified).

**Still gated behind owner approval before anything goes live:** Q1 (touch
semantics), floor distance, ratchet step/cadence, and the Kite-first vs
Webull-first build sequence — see "Open Owner Decisions" below.

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

## Broker-Neutral Capability Matrix

Protection is driven by a **broker-neutral state machine** that reads declared
capabilities per adapter — never by per-broker `if` branches in the protocol.
The credential store (`api_key_vault`) is generic; broker behavior is conditional,
so each adapter declares only combinations it has proved.

```ts
BrokerProtectiveCapabilities {
  scope: {
    market: Market
    instrumentTypes: InstrumentType[]
    sides: ("sell_long")[]
    accountModes: AccountMode[]
  }
  orders: Partial<Record<"stop_market" | "stop_limit" | "gtt_limit", {
    timeInForce: ("day" | "gtc" | "broker_managed")[]
    sessions: ("regular" | "extended" | "overnight")[]
    updateMode: "modify_in_place" | "cancel_replace" | "none"
    maxLifetimeDays: number | null
    oco: boolean
  }>>
}
```

- A flat broker-level boolean is forbidden. Support varies by order type,
  instrument, session, TIF, account entitlement, and environment. For example,
  Webull documents a GTC stop-market in `CORE`, but that does not prove the same
  stop works in extended or overnight sessions.
- GTC means the order persists across trading days; it does **not** mean the
  order can trigger in every session. Session eligibility is separate.
- An adapter with no eligible multi-day order for the exact position is declared
  **synthetic-only** — the position is flagged unprotected-by-broker, never
  silently treated as protected.
- Preference order: `stop-market` where verified (designed to trigger a market
  order, without a guaranteed execution or fill price) → GTT/`stop-limit` as
  **weaker** protection with unfilled-trigger risk surfaced in the UI.
- When a broker adds a verified capability, its adapter updates the matrix after
  a fresh schema capture; the shared protocol is unchanged.

## Protection Is Mitigation, Not a Guarantee

State this honestly in code comments and the UI — do not let it read as "loss
protection":

- A **stop-market** is designed to trigger a market order, but neither execution
  nor price is guaranteed during gaps, halts, venue/broker outages, or rejected
  orders. A floor at $90 can fill at $75 or remain unresolved.
- A **stop-limit / GTT limit child** controls price but may **never fill** on a gap
  → the position stays unprotected, which must be reported, not called filled.
- Stops generally **cannot execute while the session is closed**. A resting floor
  does not cover the gap between close and the next open.

The honest label is **outage + catastrophic-loss mitigation**, not guaranteed
loss protection.

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

**Exit provenance.** A disaster-floor fill closes the position with
`exit_reason = protective_disaster_floor`, DISTINCT from every strategy exit
(stop, target, trailing, thesis, time). The Learner excludes it from
**signal-weight attribution and genome promotion**, while the Performance Truth
Layer, NAV, realized P&L, drawdown, mandate evaluation, and risk-policy evaluation
MUST include the loss. A generic `excluded_from_learning = true` is insufficient
because the existing evaluation engine also filters that field. Use explicit
attribution such as `learning_scope = risk_policy_only` (exact schema decided
during implementation). Broker execution quality is evaluated separately from
the strategy signal that originally opened the position.

## Execution Protocol

### Entry

1. Pass all existing money-path gates and place the live BUY.
2. Reconcile the BUY fill and held quantity.
3. Compute a deterministic disaster floor from the approved mandate.
4. Reserve one protective-order intent using a stable idempotency key.
5. Place the broker floor and persist its broker id and expiry.
6. If placement, persistence, or immediate read-after-write reconciliation fails,
   create a critical health issue, mark the position unprotected, and latch a
   **broker-account + market entry circuit breaker**. Existing exits and
   risk-reducing protection writes remain enabled. Clear the latch only after a
   later reconciliation proves the correct active protection and quantity.

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

Corporate actions and broker expiry are first-class reconciliation inputs. A
split, symbol change, delisting, stale instrument id, or approaching GTC/GTT expiry
invalidates the assumed price/quantity and requires a fresh broker snapshot before
replacement. Renewal uses the same cancel/replace quantity invariant and may not
create overlapping sell capacity.

## Safety Invariants

- No LLM computes, places, modifies, or cancels protection.
- US and India accounts, cash, orders, and quantities never cross.
- Existing pause, market controls, kill switch, drawdown breaker, approval mode,
  notional limits, and account allowlist all remain upstream of **new entries**.
- Entry halts never block explicit exits, reconciliation, placement of missing
  protection on an already-held position, or an upward risk-reducing ratchet.
  They block lowering/removing protection except inside the locked explicit-exit
  or verified replacement protocol.
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
8. Every pause/kill/account/approval gate blocks new entries; an entry halt cannot
   block exits or risk-reducing protection repair on an existing position.
9. US and India fixtures cannot read or mutate the other market.
10. Paper results remain on their existing close-based semantics.
11. A disaster-floor fill records `exit_reason = protective_disaster_floor`, is
    excluded from signal-weight attribution, and remains included in P&L,
    drawdown, mandate, and protection-policy evaluation.
12. An adapter with no eligible multi-day protective order yields an
    unprotected-by-broker position, never a silently-protected one.
13. Capability fixtures reject unsupported order-type/TIF/session/account
    combinations; `GTC` alone never implies extended-hours triggering.
14. Split, expiry, partial-fill, and broker-edit fixtures cannot leave aggregate
    executable SELL quantity above the reconciled holding.

## Open Owner Decisions

1. Approve broker-hosted touch execution at all?
2. Disaster-floor distance: fixed percentage beyond analytical stop, volatility
   multiple, or mandate-specific value? Recommendation: mandate-specific ATR rule
   with a hard maximum loss bound.
3. Minimum ratchet step and update cadence.
4. Whether paper receives a separately versioned touch-fill simulation before live.
5. **Build sequence — genuine tension, owner call:**
   - *Kite-first* (this spec's build order): lifts already-written, proven GTT code
     into the shared path and delivers India protection without waiting for a new
     broker entitlement.
   - *Webull-first* (Codex's recommendation): build the signed `webull_trade`
     adapter as a reference against a richer capability set + a sandbox, but delays
     any floor until Webull entitlement and lifecycle proof are complete.
   The tradeoff is ship-protection-soonest vs build-the-abstraction-right-first.
   My lean: adopt the capability-flag interface up front (from Codex) but
   implement **Kite first** against it, since its code is proven and it delivers
   protection before the Webull entitlement/sandbox path is even confirmed.

## Build Order After Approval

1. Capture current broker schemas and write failure-injection contract tests.
2. Add protective-order state and reconciliation without placing orders.
3. Shadow the computed floor and broker capability status.
4. Implement Kite sandbox/manual path first.
5. Implement a verified Robinhood path only after live schema capture.
6. Run a single owner-approved small live test per market.
7. Keep Webull in its separate feature and disabled.

## Primary Sources

- Kite GTT lifecycle and LIMIT child orders: https://kite.trade/docs/connect/v3/gtt/
- Webull stock order types, TIF, sessions, and examples: https://developer.webull.com/apis/docs/trade-api/stock/
- Robinhood's public agent tool inventory (schema still requires live capture): https://robinhood.com/us/en/support/articles/trading-with-your-agent/
