# Feature Architecture: Live-Trading Hardening (proposal consolidation, order-status sync, snapshot parse, pre-send confirmation, broker-side protective stops)

## Status

Architecture status: P1 + P2 Implemented; P3–P5 Draft (unapproved)
Architecture approved: P1 + P2 ("build", 2026-07-07)
Approved scope: P1 (proposal consolidation) + P2 (Robinhood order-status sync)
Approved date: 2026-07-07
Implementation allowed: P1 + P2 done; P3–P5 still gated

### Implementation notes (2026-07-07)
- **P1** — `trade_queue` retired as a live path. `/api/agents/trade`,
  `/trade/approve`, `/trade/reject` now return 410. All generation → `/api/agents/trader`
  (canonical `trade_proposals`). Repointed: AgentsPage "Run TraderAgent" button,
  the dead `/api/markets/smart-money` API (now reads `trade_proposals` aliased),
  and TradingPage + PortfolioPage approve/reject (→ `/api/agents/trader`).
  `smart-money/page.tsx` already read `trade_proposals` (the real-money hazard was
  already patched). Follow-up flagged: TradingPage/PortfolioPage "queue" tabs still
  render raw `agent_signals`, so their Approve needs a proposal id — product-UX
  decision (spawned task).
- **P2** — `robinhood_mcp` adapter `getOrder` implemented via a deterministic
  `get_equity_orders` callTool (`mcpToolJson`-parsed, escaped-safe) → state map.
  The `kairos-broker-sync` loop now transitions Robinhood orders submitted→filled,
  writes `filled_qty`/`avg_fill_price` to `broker_orders` and
  `fill_price`/`fill_qty`/`filled_at` (status=executed) back to the `trade_proposal`,
  resolves the `order-needs-reconcile` System Health alert, and journals the fill.

### Still Draft / not built
- **P3** live-account snapshot parse fix, **P4** pre-send confirmation screen,
  **P5** broker-side protective stops (the real live-risk fix). Unapproved.

## Why this feature exists

The in-app Robinhood MCP live-order path now works end-to-end (first real order
placed 2026-07-07). But the surrounding machinery has correctness gaps and a
real live-risk hole that surfaced during that first order. This feature makes
live trading **correct, trackable, safe to operate by hand**, and — critically —
**protected by broker-side stops** so a live position isn't left unguarded when
the app/cron isn't running. It does NOT add autonomous execution (separate,
later, deliberately gated) and does NOT add limit-order entries (low value for
this app's daily-cadence style).

Sequenced in phases; each is independently approvable and shippable. Recommended
order: P1 → P2 → P3 (small) → P4 → P5.

## Non-Goals

- **No autonomous live execution.** Every live order still requires a human
  approve + send. `trading_mode='auto'` stays unimplemented; its architecture is
  a separate doc drafted only after a paper track record justifies it.
- **No limit-order entries.** Daily-cadence trades on liquid names are fine with
  market orders; limit-order management (unfilled orders, cancel/replace, GTC
  tracking) is complexity this app's edge doesn't need. Revisit only if a real
  need appears (e.g. routinely trading illiquid names).
- **No standalone live-orders history page** in this feature — `broker_orders`
  plus Robinhood's own app already hold the record. A minimal orders list may
  ride along with P4, but a polished history/analytics page is out of scope.
- No change to the paper-trading loop's simulation math.

---

## Phase 1 — Consolidate the proposal system (`trade_queue` → `trade_proposals`)

### Purpose / current bug
Two tables model "a proposed trade":
- `trade_queue` — written by the legacy generator `app/api/agents/trade` and
  READ by the Smart Money Trade Queue UI (`/api/markets/smart-money`).
- `trade_proposals` — written by the main `app/api/agents/trader` and the ONLY
  table the Execution Gateway (`app/api/broker/orders`) reads.

So the UI shows `trade_queue` rows, but the Gateway acts on `trade_proposals`.
The paper/live "send" buttons pass the displayed row's id as a `proposal_id` to
the Gateway — which looks it up in `trade_proposals`. If the ids don't align
(they don't in general), the Gateway either 404s or, worse, **acts on a
different proposal with the same id**. This is a real-money correctness hazard —
it's why the Send-LIVE button was NOT shipped.

### Proposed behavior
- `trade_proposals` becomes the single source of truth for proposals.
- `/api/markets/smart-money` (and any UI reading `trade_queue`) reads
  `trade_proposals` instead; the Trade Queue renders `trade_proposals` rows, so
  the id sent to the Gateway is guaranteed correct.
- The legacy `/api/agents/trade` generator (writes `trade_queue`) is retired or
  repointed to write `trade_proposals`. Its approve/reject routes
  (`/api/agents/trade/approve|reject`) are consolidated onto the
  `trade_proposals` approve/reject the trader route already uses.
- `trade_queue` is left in place (not dropped) but no longer written/read; a
  follow-up migration can archive it once verified unused.

### Files (verify against live code before building)
- `app/api/markets/smart-money/route.ts` (read `trade_proposals`)
- `components/dashboard/SmartMoneyPage.tsx` (field-name mapping to
  `trade_proposals` columns; the queued Send-LIVE button becomes safe here)
- `app/api/agents/trade/route.ts` + `trade/approve|reject` (retire/repoint)
- Any other reader of `trade_queue` (grep before changing).

### Acceptance criteria
- The Trade Queue UI renders `trade_proposals`; a row's id equals the
  `proposal_id` the Gateway resolves — verified by sending a paper order and
  confirming the Gateway operates on the same row shown.
- No code path sends a `trade_queue` id to the Gateway.
- No behavior change to how proposals are generated/approved beyond the table.

---

## Phase 2 — Robinhood order-status sync (`unconfirmed → filled`)

### Purpose / current gap
After a live Robinhood order is placed it sits at Robinhood state `unconfirmed`,
then fills. The app never learns: `lib/brokers/adapters/robinhood-mcp.ts`'s
`getOrder()` is a stub, and the sync loop (`app/api/broker/orders/sync`) has no
Robinhood branch. So `broker_orders.status` stays `submitted` and the fill
price/qty/position never update in-app.

### Proposed behavior
- Implement the Robinhood adapter's `getOrder(brokerOrderId)` via a deterministic
  MCP `get_equity_orders` (or the single-order variant if the server exposes one)
  `callTool`, parsed with `mcpToolJson` (the escaped-content-safe helper added
  when fixing the first order). Map Robinhood order `state`
  (unconfirmed/confirmed/partially_filled/filled/cancelled/rejected) → the
  adapter's `BrokerOrderState.status` union.
- The existing sync cron (`kairos-broker-sync`, every 30 min market hours)
  already iterates DISTINCT brokers in open orders — it will pick up
  `robinhood_mcp` orders once `getOrder` works. Update `broker_orders`
  (status, filled_qty, avg_fill_price, raw_last_state redacted) + on fill write
  back `trade_proposals.fill_price/fill_qty/filled_at` and a `decision_journal`
  fill entry.

### Files
- `lib/brokers/adapters/robinhood-mcp.ts` (`getOrder`, maybe `cancelOrder`)
- `lib/robinhood-mcp.ts` (a `queryRobinhoodOrder(id)` helper if useful)
- `app/api/broker/orders/sync/route.ts` (confirm Robinhood orders flow through)

### Acceptance criteria
- A placed Robinhood order transitions in-app `submitted → filled` after the
  sync runs, with the real fill price/qty recorded.
- `mcpToolJson` parsing handles Robinhood's escaped text content (no false
  "unparseable" like the first order hit).
- Tokens/account numbers never persisted in `raw_last_state`.

---

## Phase 3 — Live-account snapshot parse fix (small)

### Purpose / current bug
`refreshViaMcp` (in `app/api/live-account/refresh-snapshot`) connected and ran
`get_accounts`/`get_equity_positions`, but its regex parse of the escaped MCP
text content left `equity`/`buying_power`/`portfolio_value` NULL and
`positions_json` empty. So the live holdings view shows nothing.

### Proposed behavior
- Reparse using `mcpToolJson`: extract account equity/buying_power/portfolio_value
  and the positions array from the parsed object shape (to confirm against a real
  `get_accounts`/`get_equity_positions` response), not a flat regex.
- Same fix applies to `robinhoodHeldQty` (the sell-if-held gate) — parse the
  positions via `mcpToolJson` so live SELLs validate correctly.

### Acceptance criteria
- After a cloud MCP snapshot refresh, `live_account_snapshots` for the trading
  account shows non-null equity + a populated positions array.
- `robinhoodHeldQty` returns a correct held quantity for a known holding.

---

## Phase 4 — Pre-send confirmation screen (real-money "don't fat-finger")

### Purpose
Today a live order is sent with only a JS `confirm()` (or a raw console call).
Before committing real money the user should see Robinhood's OWN reviewed
numbers (from `review_equity_order`) — symbol, side, qty, order type, estimated
price/cost, account — and explicitly confirm THAT.

### Proposed behavior
- A new owner-only endpoint `POST /api/broker/orders/review` runs the Gateway's
  pre-flight (all gates) + the broker's `review_equity_order` and returns the
  reviewed order preview WITHOUT placing anything.
- The Send-LIVE flow becomes: click → modal shows the reviewed preview (price,
  qty, est cost, account, cap headroom, any gate warnings) → user confirms →
  Gateway places (reusing the already-fetched review where possible).
- Applies to all brokers (Alpaca/Kite show their equivalent preview).

### Files
- `app/api/broker/orders/review/route.ts` (new, owner-gated)
- `lib/robinhood-mcp.ts` (a `reviewRobinhoodOrder()` that returns the parsed
  preview; today review happens inside `submitRobinhoodOrder` — split it out)
- `components/dashboard/SmartMoneyPage.tsx` (confirmation modal) — depends on P1
  so the button acts on the right table.

### Acceptance criteria
- No live order is placed without the user seeing the broker-reviewed numbers
  and confirming them.
- The review endpoint never places an order (pure preview) — verified.

---

## Phase 5 — Broker-side protective stops (the real live-risk fix)

### Purpose / current gap (most important item)
Stops/targets are managed APP-SIDE: `PositionMonitor` polls prices and sends a
market exit when a stop/target is hit. Fine for paper (simulated). For LIVE
money it's dangerous: if the app or its cron isn't running (deploy down, cron
missed, overnight gap), a live position has **NO broker-side stop** — it can gap
against you with nothing protecting it. Real capital needs a resting stop at the
broker.

### Proposed behavior (to be refined against Robinhood's MCP order schema)
- When a LIVE entry fills, place a corresponding **broker-side protective stop**
  (a resting stop-loss order at the MAE-derived stop price the app already
  computes), if Robinhood's MCP supports stop orders (confirm via `tools/list` /
  the `place_equity_order` schema: `type: stop` / `stop_price`, or a bracket/OCO
  facility). Prefer a native bracket/OCO if available so the stop auto-cancels on
  target fill.
- If Robinhood does NOT support a resting stop via MCP: surface this clearly and
  keep app-side monitoring as the only stop, with an explicit UI warning that
  live positions are only protected while the app is running (honest about the
  limitation rather than pretending there's a safety net).
- `PositionMonitor` becomes broker-env aware: for a LIVE position with a
  broker-side stop already resting, it should NOT also fire its own market exit
  (avoid double-exit / racing the broker stop). It reconciles against the
  broker's open orders first.
- All stop placements go through the same Gateway gates + are deterministic (no
  LLM), same as entries.

### Open questions to resolve before building (verify, don't guess)
- Does Robinhood's agentic MCP `place_equity_order` accept `type: "stop"` /
  `stop_price`, and/or a bracket/OCO? (Inspect the live tool schema.)
- Partial-fill handling: stop qty must track the actual filled qty, not the
  ordered qty.
- Cancel/replace semantics for adjusting a trailing stop broker-side vs
  app-side.

### Acceptance criteria
- A LIVE entry fill results in a resting broker-side stop at the intended price
  (if supported), verified on the account.
- PositionMonitor does not double-exit a live position that has a broker stop.
- If broker stops are unsupported, the UI states plainly that live stops are
  app-side only (running-app dependent).

---

## Cross-cutting guardrails (all phases)

- Every live order/stop/cancel goes through the Execution Gateway's full gate
  set (owner, CSRF, kill switches, `robinhood_mcp_enabled`, per-market
  trading_enabled, notional cap, fresh-quote/drift, allowlist), deterministic,
  no LLM in the write path.
- `needs_reconcile` semantics preserved; no auto-retry of any write.
- No secrets/account numbers in persisted `raw_last_state`.
- `robinhood_mcp_enabled` remains the fast kill switch; `max_order_notional`
  stays a hard cap.

## Deferred to their own specs (explicitly not this feature)

- **Autonomous live mode** (`trading_mode='auto'`: auto-approve + auto-send +
  enforced limits + master autonomous kill-switch) — separate doc, gated on a
  paper track record.
- **Limit-order entries** — only if a concrete need appears.
- **Standalone live-orders history/analytics page.**

## Approval

Architecture approved: No
Approved scope: None
Implementation allowed: No
