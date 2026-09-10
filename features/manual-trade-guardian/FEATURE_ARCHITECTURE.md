# Manual Trade Guardian — Architecture Proposal

> Status: **Stage 0 approved 2026-09-09 and IMPLEMENTED.** Migration applied
> and verified (`agentic_position_ledger`, `learner_runs.live_trades_closed`/
> `live_win_rate`). Cron `kairos-manual-fill-detect` registered (`*/15 13-21
> * * 1-5`). Route: `app/api/agents/manual-fill-detect/cron/route.ts`. Pure
> core: `lib/trading/manual-fill-detection.ts`, tested
> (`tests/manual-fill-detection.test.ts`, 11 cases). Stage 1 (the
> Stage 1 is implemented 2026-09-09: an owner-armed software-stop plan,
> immutable plan-event ledger, owner panel on Live Portfolio, and a gated
> monitor. It is deliberately **not** a `trade_proposals` approval card: that
> existing control executes a SELL immediately, which is unsafe for arming.
> Owner ask (2026-09-08): "if I buy manually in the agentic account, add the
> right stop loss ASAP; I'll sell manually myself; track manual vs app-placed."
> This document is the architecture gate required before any code is written.

> **2026-09-09 remediation:** the initial implementation did not satisfy its
> own position-ledger contract. The first snapshot had no baseline state,
> partial sells were skipped, full exits were hard-coded manual, missing cost
> basis became current price, and client roles retained TRUNCATE. The approved
> repair adds lease-backed bootstrap state, records every quantity transition,
> supports aggregate order attribution plus explicit unknown, preserves null
> cost basis, adds the market-calendar gate, and reconciles the schema/grants
> through `20260909153000_guardian_and_broker_preflight_safety.sql`.

---

## 1. What's true today (verified against code + production, not assumed)

- **`PositionMonitor` never watches live Robinhood positions.** It reads only
  `paper_positions` (`app/api/agents/position-monitor/route.ts`). A live
  position — manual or agentic — gets no trailing stop, no exit logic, nothing.
- **`strategy_config.protective_orders_enabled = false`** in production. Even
  where protective-order placement exists (Kite side), it's off by default.
- **`broker_orders` has no source column**, and it only ever gets a row when
  *Kairos* proposes an order. `broker/orders/sync` reconciles Alpaca/Kite fills
  back onto rows that already exist — it never discovers a fill Kairos didn't
  create. A manual Robinhood-app buy creates **no row anywhere**.
- **Robinhood order placement in this codebase supports `market` and `limit`
  only** (`RobinhoodOrderInput.type`, `lib/robinhood-mcp.ts:585`). There is no
  broker-side stop order wired for Robinhood. Kite's "stop" path
  (`lib/kite.ts:223`) is actually a plain LIMIT order placed at the stop price
  — also not a broker-native stop.
  **Consequence: "attach a stop loss" cannot mean a broker-resident stop order
  today.** It has to mean the same thing it means for paper positions — a
  software watch that submits a market/limit SELL when the price breaches the
  level, running on Kairos's own cron. This must be stated to the owner
  plainly in the UI, not implied to be a real broker stop.
- **No cron runs more often than daily.** `vercel.json`'s finest schedule is
  `autonomous-live` at once/day per market. "ASAP" is therefore bounded by
  whatever polling cadence this feature adds — realistically 5–15 minutes on
  Vercel's free-tier cron granularity, not real-time. Stating this honestly
  matters more than the word "ASAP" — a false real-time claim is the kind of
  cryptic status this project's own conventions forbid.
- **`trade_proposals`** already has exactly the shape an approval card needs:
  `symbol, side, qty, order_type, thesis, key_risks, status,
  approval_expires_at, robinhood_order_id, account_number, execution_mode`.
  This is the existing owner-approval mechanism (Settings → whatever surfaces
  pending proposals today) and should be reused, not duplicated.
- **`lib/research-agent.ts` already computes `stop_loss_pct`** from
  `tradingMandate` for every paper entry (`lib/research-agent.ts:1786`). The
  same function is the correct source for a manual fill's stop — not a new
  formula.
- Account allowlist is unchanged by this feature: `605420660` is the only
  order-permitted account; everything else stays read-only.

## 2. Design

### 2.1 Detection (new, tight-cadence cron)

New route `POST /api/agents/manual-fill-detect/cron`, cron-secret gated,
scoped to `605420660` only.

Each run:
1. Fetch live positions for `605420660` via `fetchRobinhoodBrokerAccounts`
   (same call `holding-risk` already makes — reuse, don't re-implement).
2. Compare against a new **position-ledger snapshot** (see schema below) —
   the last known qty per symbol this feature itself recorded.
3. A qty increase with **no matching open/filled `broker_orders` row** for
   that symbol/qty/window = a manual fill. A qty increase that DOES match an
   already-known `broker_orders` fill is Kairos's own trade — not manual,
   ignore.
4. Every fill (manual or matched) gets written to the position ledger with
   `source: 'manual' | 'agentic'`. This is the "track what was done manually
   vs by the app" ledger the owner asked for, independent of whether a stop
   ever gets attached.

Cadence: as tight as the free-tier cron budget allows (proposal: every 15
minutes during US market hours only, to keep the polling budget small and
honest about latency). Exact number is an implementation decision, not an
architecture one — flagged as open below.

### 2.2 Stop computation (reuse, not reinvent)

On detecting a manual fill: call the same stop-loss function
`research-agent.ts` uses for paper entries, with the mandate's
`stop_loss_pct` and the fill's entry price. Output: one suggested stop price,
nothing else. No new stop-sizing model.

### 2.3 Approval — arm a plan, never submit on approval

**This is the load-bearing decision in this document.** The first draft said a
`trade_proposals` SELL could be used for this approval. That was wrong: its
existing approval handler executes the SELL at once. Guardian instead creates
a dedicated `guardian_protection_plans` record in `pending_approval`:

```
account_id: 605420660
symbol, qty, entry_price, stop_price
status: pending_approval → armed
```

The owner sees it in the dedicated Live Portfolio **Manual Trade Guardian**
panel and taps **Arm stop**. This records owner attribution plus an immutable
`armed` event. It submits no broker order. The UI states plainly that this is
a Kairos software stop, not a broker-resident stop.

**Why not auto-place:** the project's own push-back mandate flags "Running
real TraderAgent orders without approval_required mode." An unattended stop
placed the instant a fill is detected is the same class of autonomy jump that
rule exists to catch, even though the intent here is protective. If the owner
later wants it fully automatic, that is a separate, explicit decision —
Section 4.

### 2.4 Once a stop is armed — who watches it?

Because Robinhood has no broker-native stop, a sibling monitor reads an armed
plan only after **both** `AUTONOMOUS_LIVE_ENABLED` and
`strategy_config.live_auto_enabled` are on, the app is not paused/locked, the
active US account is exactly `605420660`, and the US market is open. It then
requires a fresh quote at or below the committed stop, atomically claims the
plan, creates one `autonomous_live` market SELL proposal, and calls the same
hardened execution gateway used by the live exit monitor. The gateway still
re-verifies held quantity, broker allowlist, autonomy level, market controls,
and kill switches. Any failed/ambiguous submission becomes
`trigger_needs_reconcile`; it never silently retries another SELL.

### 2.5 Manual sell — explicitly out of scope for automation

The owner said they'll sell manually themselves. Nothing here watches for or
reacts to a manual sell beyond recording it in the position ledger
(`source: manual`) when qty drops with no matching Kairos sell order.

## 3. Schema (applied and verified 2026-09-09)

```sql
create table agentic_position_ledger (
  id bigint generated always as identity primary key,
  account_id text not null,            -- '605420660' only, checked
  symbol text not null,
  qty numeric not null,
  avg_cost numeric,
  source text not null check (source in ('manual','agentic')),
  detected_at timestamptz not null default now(),
  matched_broker_order_id bigint references broker_orders(id),
  suggested_stop_price numeric,
  stop_proposal_id bigint references trade_proposals(id),
  created_at timestamptz not null default now()
);
-- append-only by convention (matches broker_orders/observation_labels idiom);
-- RLS: service-role write, owner read, same posture as broker_orders.
```

Stage 1 adds `guardian_protection_plans` (the current state, one per detected
manual-buy ledger entry) and append-only `guardian_protection_events`. The
database function `create_guardian_protection_plan` inserts both atomically:
there can be no armed/visible plan without its `created` evidence event.

## 4. Explicitly NOT in this proposal

- **Does not touch `strategy_config.live_auto_enabled` or `autonomy_level`.**
  That is a separate decision the owner has not yet made (raised, not
  answered, this session).
- **Does not place any order automatically.** Detection and stop-sizing are
  automatic; placement is always owner-approved.
- **Does not add a broker-native stop order type.** None exists for Robinhood
  in this codebase; building one is a distinct, larger scope (would need
  Robinhood MCP support that hasn't been confirmed to exist) and is not
  assumed here.
- **Does not watch Kite/India manual fills.** The owner's ask was specifically
  the agentic (Robinhood, `605420660`) account. India protective-order
  placement already exists on a separate, more mature path
  (`lib/protective/`); extending detection there is a future, separate ask.

## 5. Decisions implemented

1. **Poll cadence:** existing 15-minute US-market-hours Guardian cron. This is
   monitoring latency, not a real-time or broker-native guarantee.
2. **Sell order on breach:** market. A stop-loss's safety objective is to
   reduce exposure; a limit could remain unfilled during a fast fall.
3. **No minimum notional floor:** every detected manual buy with a real cost
   basis receives a suggestion. Noise is cheaper than leaving a small test
   position falsely unprotected.

## 6. Sequencing

Detection + ledger → pending Guardian plan → owner arms the plan → later
verified breach → gateway-gated market SELL. The user has not enabled the
existing live switch, so the deployed monitor presently refuses before quote
or broker work. No external order was sent while implementing this feature.
