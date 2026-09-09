# Manual Trade Guardian — Architecture Proposal

> Status: **Stage 0 approved 2026-09-09 and IMPLEMENTED.** Migration applied
> and verified (`agentic_position_ledger`, `learner_runs.live_trades_closed`/
> `live_win_rate`). Cron `kairos-manual-fill-detect` registered (`*/15 13-21
> * * 1-5`). Route: `app/api/agents/manual-fill-detect/cron/route.ts`. Pure
> core: `lib/trading/manual-fill-detection.ts`, tested
> (`tests/manual-fill-detection.test.ts`, 8 cases). Stage 1 (the
> approval-card UI that lets a suggested stop actually be placed) remains
> unbuilt — see Section 6.
> Owner ask (2026-09-08): "if I buy manually in the agentic account, add the
> right stop loss ASAP; I'll sell manually myself; track manual vs app-placed."
> This document is the architecture gate required before any code is written.

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

### 2.3 Approval — proposal, never silent placement

**This is the load-bearing decision in this document.** A stop is not placed
automatically. A `trade_proposals` row is created:

```
side: sell, order_type: limit (or market, TBD by risk profile)
thesis: "Manual buy detected: <qty> <symbol> @ <entry> — suggested protective
         stop at <price> (<pct>% below entry, per your mandate's stop_loss_pct)"
account_number: 605420660
status: pending
approval_expires_at: <mandate-consistent window>
```

The owner sees it exactly where every other pending proposal already
surfaces, taps approve, and the **existing** approval → order-placement path
executes it — no new placement code, no new gate. `protective_orders_enabled`
continues to gate whatever it already gates; this feature adds no new
unattended write path to a live account.

**Why not auto-place:** the project's own push-back mandate flags "Running
real TraderAgent orders without approval_required mode." An unattended stop
placed the instant a fill is detected is the same class of autonomy jump that
rule exists to catch, even though the intent here is protective. If the owner
later wants it fully automatic, that is a separate, explicit decision —
Section 4.

### 2.4 Once a stop is approved and placed — who watches it?

Because Robinhood has no broker-native stop, "placed" means: the SELL order
sits as a `trade_proposals`/`broker_orders` row, and `PositionMonitor` (or a
sibling using its logic) must be extended to watch this position's live price
and submit the SELL when breached — the same trailing-stop mechanism paper
positions already get, applied to a live position for the first time. This is
new scope inside PositionMonitor, not a new engine.

### 2.5 Manual sell — explicitly out of scope for automation

The owner said they'll sell manually themselves. Nothing here watches for or
reacts to a manual sell beyond recording it in the position ledger
(`source: manual`) when qty drops with no matching Kairos sell order.

## 3. Schema (proposed — NOT applied; needs the owner's DB-apply step before
any code ships, per this project's schema-verification rule)

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

## 5. Open questions before implementation starts

1. **Poll cadence** — 15 min during market hours is a proposal, not a
   decision. Tighter costs more cron budget; looser makes "ASAP" less true.
2. **Sell order type on stop breach** — market (certain fill, worse price) or
   limit (better price, may not fill in a fast drop)? Paper positions default
   to whichever `PositionMonitor` already uses; confirm that's the right
   default for real capital.
3. **Does the owner want a stop suggested even for a very small manual buy**
   (e.g., a $50 test position), or should this have a minimum-notional floor
   to avoid alert noise?

## 6. Sequencing

Stage 0 (this document) → owner approval → build detection + ledger (no UI
yet, alert-only via `agent_alerts`) → verify against a real manual fill in
production → build the approval-card UI + source filter on My
Trades/Live Portfolio → verify end-to-end with the owner approving a real
suggested stop.

Nothing in Stage 0 is reversible-cost: it is read-only detection plus
proposal rows. The first live-money action (an actual stop placement) only
happens on explicit owner tap, same as every other live order today.
