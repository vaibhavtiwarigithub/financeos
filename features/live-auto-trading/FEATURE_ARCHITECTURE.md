# Live Auto Trading — Feature Architecture

**Last updated:** 2026-07-10  
**Status:** IMPLEMENTING PA3 — per-market off/manual/autonomous mode (approved by owner)  
**Authors:** Claude Sonnet 4.6; security and execution architecture reviewed by ChatGPT/Codex, 2026-07-10  
**Scope:** Per-market autonomous mode (US via Robinhood direct REST; India via Kite REST). Both markets support off/manual/autonomous independently.

---

## 1. Safety correction and goal

The previous draft was not safe to implement. It used the wrong Robinhood account number (`605420606`), bypassed the hardened Execution Gateway by calling `submitRobinhoodOrder()` directly, used a race-prone read/sum daily cap, allowed a fallback NAV, and proposed auto BUY before live exit/reconciliation was complete.

**Authorized order account:** `605420660` only. Read-only account `965848641` may be used only for the explicitly approved holdings-research path and must never price, size, authorize, or execute an order for the agentic account.

The goal remains valid: after Kairos proves a scoring version in shadow/paper evidence, Vaibhav may enable an autonomous **risk envelope**. Individual orders inside that envelope need not require a click. Enabling autonomy does not allow an LLM to control money limits, activate scoring versions, choose accounts, or bypass deterministic gates.

---

## 2. Required architecture

There must be one shared execution kernel for manual and autonomous orders.

```text
Research/Scoring → eligible signal → proposal
                                  ↓
                    authorization context
              manual_owner | autonomous_worker
                                  ↓
                  executeApprovedProposal()
          (same account/risk/quote/budget/order gates)
                                  ↓
                       broker adapter
                                  ↓
             broker_order + append-only events
                                  ↓
        sync/reconcile partial fill/fill/cancel/reject
                                  ↓
               live position + protective exit
```

### Shared execution kernel

Extract the money-moving logic in `app/api/broker/orders/route.ts` into a server-only function, for example:

```typescript
executeApprovedProposal({
  proposalId,
  env: "live",
  actor: { kind: "owner", userId } | { kind: "autonomous_worker", runId },
})
```

The owner route keeps `requireOwner()` and calls this function. A new cron/worker route uses `verifyCronSecret()`, obtains a single-run lease, and calls the same function. Neither caller may invoke `submitRobinhoodOrder()` directly.

The kernel owns all gates: broker/account resolution, autonomy policy, kill switches, signal quality, scoring-version eligibility, fresh account state, per-order cap, portfolio limits, quote freshness/drift, held-position SELL, atomic daily budget reservation, broker schema/review, idempotency, durable state transitions, and alerts.

---

## 3. Authorization and activation

Autonomy uses independent keys that all must pass:

1. deployment flag `AUTONOMOUS_LIVE_ENABLED=true` (false/absent by default);
2. `strategy_config.autonomy_level = 'L4_live_small_auto'`;
3. `live_auto_enabled = true`;
4. unexpired `live_auto_enabled_until` lease;
5. global and US trading switches on;
6. Robinhood MCP enabled and token healthy;
7. active account resolves from the allowlist to `605420660` with role `trading`;
8. active scoring strategy is `live_approved` with linked validation evidence;
9. no unresolved critical trading/data/reconciliation alert.

Unknown or missing values fail closed. Do not replace the deployment kill constant with only a DB boolean. The environment flag is a release control; the DB toggle is an owner runtime control.

Settings changes require owner authorization, CSRF/request guards, a recent session or vault-PIN re-auth, typed `ENABLE AUTO`, and an append-only decision-journal record containing old/new policy, actor, timestamp, and expiry. L4 begins as a maximum 24-hour renewable lease. A future L5 design may extend the lease only after evidence.

LLMs and agents cannot change any activation key, cap, account, strategy lifecycle, or lease.

---

## 4. Database changes (additive)

Use the next real migration number. Apply and verify migrations before code.

### `strategy_config`

```sql
live_auto_enabled boolean not null default false
live_auto_enabled_until timestamptz
live_auto_policy_version integer not null default 1
live_auto_daily_cap_usd numeric
live_auto_max_per_order_usd numeric
live_auto_min_evidence_confidence numeric
live_auto_max_open_positions integer
live_auto_max_orders_per_day integer
```

Add non-negative/range checks. Defaults must be conservative and never larger than the existing `max_order_notional_usd`, `max_daily_notional_usd`, or `max_daily_trades`; runtime uses the **minimum** of global/account/auto limits. Do not create parallel caps that can enlarge an existing cap.

### `trade_proposals`

Add `execution_mode ('manual'|'auto')`, `policy_snapshot jsonb`, `auto_run_id uuid`, and `auto_decided_at`. Existing proposal statuses should remain business-intent statuses. Do not overload them with broker fill state; `broker_orders` owns execution state.

Add only schema-compatible status values after inspecting the current CHECK constraint. Suggested proposal states: `pending_review`, `approved`, `queued_auto`, `submitted`, `manual_review_required`, `failed`, `expired`, `cancelled`. Ambiguity lives on the broker order as `unknown_needs_reconcile`.

### Budget reservation and actor audit

The current `reserve_live_order_budget` serializes per market/day correctly, but hardcodes `approved_by_user=true`. Do not use it unchanged for autonomous orders.

Create a new versioned RPC (for example `reserve_live_order_budget_v2`) rather than accidentally creating an overloaded function with ambiguous PostgREST resolution. It must:

- be `SECURITY DEFINER` only if necessary;
- set a fixed safe `search_path`;
- validate every enum/value and reject null/invalid notional for live BUY;
- accept `execution_actor` and persist `approved_by_user = (actor='owner')`;
- use a market-local-day advisory transaction lock;
- count reserved/submitted/partial/unknown BUY notional so timeouts cannot reopen budget;
- exempt held-position SELL exits from BUY budget;
- insert the `pending_submit` broker row in the same transaction;
- be revoked from `PUBLIC`, `anon`, and `authenticated`, granted only to `service_role`;
- preserve the unique active-order-per-proposal backstop.

RLS remains enabled on exposed tables; service-role-only tables have explicit revoked grants. Run Supabase advisors and verify RPC permissions.

### Append-only execution events

Add `broker_order_events` as an append-only lifecycle ledger if it does not already exist. `broker_orders` remains mutable current state. Each transition records broker/order IDs, event type, quantities, prices, raw hash/redacted payload, actor/run, and timestamp. Never store tokens.

---

## 5. Autonomous proposal eligibility

A proposal may be queued for auto execution only when all are true:

- market is US;
- account target is exactly `605420660` after allowlist resolution;
- side is BUY for a new long or SELL for a verified held position;
- signal source is deterministic and scoring strategy lifecycle is `live_approved`;
- signal/quote/proposal are within configured freshness windows;
- evidence confidence meets the auto threshold with no override;
- no LLM veto, taint, unknown quality, or unresolved provider substitution;
- mandate permits the asset/setup;
- no earnings/ex-dividend/corporate-action blackout required by the approved setup policy;
- a protective exit can be established and monitored;
- proposal has a deterministic idempotency key and policy snapshot.

`analyst_score >= 80` alone is not eligibility. A 0–100 heuristic is not a calibrated probability. Prefer validated `expected_return_bps`, uncertainty, setup lifecycle, and evidence gates when available.

The autonomous path has **no** `acceptLowQuality` or `acceptPortfolioRisk` override. Those remain owner-only manual actions with audited reasons.

---

## 6. Pre-submit gate order

Every gate is rerun immediately before broker submission:

1. actor authorization and single-worker lease;
2. policy lease/version and current strategy lifecycle;
3. trading flags, broker token, and account allowlist;
4. kill switches and critical-alert check;
5. proposal expiry, source/version, direction, quality, and mandate;
6. fresh agentic-account portfolio/positions; no fallback NAV;
7. valid integer quantity and held quantity for SELL;
8. minimum of per-order/global/auto caps in USD;
9. portfolio concentration/correlation/volatility limits;
10. fresh executable quote, max age, spread, and price-drift collar;
11. atomic daily budget/idempotency reservation;
12. `review_equity_order` with symbol/side/qty/account echo verification;
13. broker submit;
14. durable result/event write before returning.

Any read error, null, stale state, malformed preview, or failed audit on a money path fails closed. Do not use `FALLBACK_NAV`. Do not downgrade a failed auto order to an immediately executable manual command; create `manual_review_required` and force a new owner review/fresh gates.

For swing entries, prefer a marketable limit with a price collar if the MCP tool schema supports it. If only market orders are supported, constrain liquidity/spread/time window and document that risk. Never guess MCP parameters; discover the live tool schema and make the preview echo mandatory.

---

## 7. Exit protection is a launch blocker

Autonomous BUY cannot launch before an operational live exit path exists.

Minimum:

- current agentic holdings synced frequently during market hours;
- protective stop policy recorded at entry;
- deterministic held-position SELL through the same Execution Gateway;
- SELL quantity capped to verified available quantity after open orders/partial fills;
- stop/time/target/kill-switch exits prioritized above new entries;
- protective SELL is never blocked by BUY notional/daily budget;
- if broker-native stop/bracket support exists, preview and place it deterministically;
- if no broker-native protection exists, the runtime must have heartbeat/staleness alerts and the L4 allocation must remain tiny.

If protective exit cannot be installed or the monitor is stale, reject the BUY and disable/expire L4. Tax or dividend preferences may influence normal exits but cannot delay a risk stop.

---

## 8. Order lifecycle and reconciliation

External exactly-once execution cannot be assumed. Use durable at-most-once intent plus reconciliation:

- reserve before submit;
- send a client idempotency key if supported;
- ambiguous timeout/no broker ID → `unknown_needs_reconcile`, keep budget reserved, block symbol/proposal retry;
- clean rejection → `error/rejected`, release only according to explicit RPC policy;
- partial fill → persist filled and remaining quantities; never blindly resubmit remainder;
- order-sync worker queries broker order state during market hours and resolves submitted/partial/unknown states;
- reconciliation compares broker orders, fills, positions, proposals, and local ledger;
- any mismatch opens a critical alert and blocks new autonomous entries while allowing verified risk-reducing exits.

Kill-switch behavior: stop new orders and attempt to cancel resting entry BUY orders if an authenticated, tested cancel tool exists. Never cancel protective SELL orders automatically. If cancel capability is unavailable or fails, alert critically and instruct broker-level intervention.

Email is notification only. Durable DB alerts/events are the source of truth; email failure must not erase the order result.

---

## 9. Position sizing

Sizing is deterministic and bounded:

```text
raw opportunity size = portfolio constructor(calibrated edge, uncertainty, volatility, correlation)
final notional = min(raw size,
                     global per-order cap,
                     auto per-order cap,
                     remaining daily auto budget,
                     mandate/name/sector/gross limits,
                     available buying power)
```

If calibrated edge or NAV is unknown, autonomous BUY size is zero. Paper and manual pathways may show a proposal, but auto must abstain. Integer quantity rounds down; zero shares means no order. Recompute with a fresh quote immediately before reservation.

The LLM cannot size. A “great opportunity” can increase size only through the validated numeric opportunity model and only up to every hard ceiling.

---

## 10. Rollout

### PA0 — architecture/schema/UI only

- additive migrations, RLS/grants/checks;
- Settings card and audited time-bounded enablement;
- deployment flag remains false;
- no autonomous order route.

### PA1 — shadow autonomous decisions

- extract and test shared execution kernel;
- auto worker evaluates proposals and records would-submit/would-block reasons;
- no broker submit;
- compare shadow decisions to manual outcomes for at least the approved evidence window.

### PA2 — reconciliation and live exits

- broker-order event ledger and sync worker;
- partial-fill/unknown reconciliation;
- deterministic live held-position exits/protective policy;
- chaos tests for timeouts, duplicate cron, stale account, quote failure, and DB failure.

### PA3 — tiny L4 live

- owner promotes a scoring version to `live_approved`;
- explicit deployment flag + 24-hour DB lease;
- one order at a time, tiny caps, liquid allowlist, no unresolved critical alerts;
- watched first executions and rollback drill.

### PA4 — evidence-based expansion

Increase limits only by owner action after net live results, reconciliation accuracy, drawdown, and operational SLOs pass. No automatic cap expansion.

India auto trading is a separate architecture. It must use Kite’s official HTTP API through the same execution kernel, INR-only limits, CNC product, exchange/order validation, token health, and live exit/reconciliation parity.

---

## 11. Acceptance tests

- Any account other than `605420660` is rejected before reserve/preview/submit.
- Auto caller cannot call the broker adapter directly; static test verifies only shared kernel imports it.
- Deployment flag false, expired lease, invalid autonomy level, or DB read error blocks auto.
- Two concurrent runs for one proposal yield one reservation and at most one submit intent.
- Concurrent different proposals cannot exceed daily count/notional.
- Auto broker row records `approved_by_user=false` and autonomous run ID.
- Unknown outcome remains budget-reserved and cannot be retried.
- Preview mismatch on account/symbol/side/qty blocks submit.
- Missing/stale NAV or holdings blocks BUY and SELL authorization as appropriate; no fallback NAV.
- Low/unknown quality and portfolio-risk overrides are impossible in auto.
- Scoring version not `live_approved` cannot auto trade regardless of score.
- Partial fill cannot cause oversell or automatic remainder resubmit.
- Protective exit failure blocks new entry.
- Kill switch blocks entries, preserves/permits risk-reducing exits, and handles resting BUY cancellation safely.
- Secrets/tokens never appear in logs, events, emails, or raw payloads.

---

## 13. PA3 Implementation Details (2026-07-10)

### Per-market mode

New columns on `strategy_config` (migration 141):
- `live_auto_mode_us TEXT DEFAULT 'manual' CHECK IN ('off','manual','autonomous')`
- `live_auto_mode_india TEXT DEFAULT 'manual' CHECK IN ('off','manual','autonomous')`

Three modes per market:
- `off` — autonomous-live cron skips this market entirely
- `manual` — TraderAgent creates proposals; owner clicks Approve (existing flow, unchanged)
- `autonomous` — execution kernel + live broker REST submit from cron, no per-order click

### New cron: autonomous-live (14:00 UTC, weekdays)

Runs AFTER research (13:00 UTC / 9 AM ET) so same-day signals exist.
Route: `POST /api/agents/autonomous-live/cron` — timing-safe CRON_SECRET auth.
Shadow cron at 07:30 UTC unchanged.

### US execution path (no MCP in serverless)

Direct Robinhood REST via `lib/brokers/robinhood/rest-client.ts`:
- Token from vault key `ROBINHOOD_MCP_ACCESS_TOKEN`
- `GET https://api.robinhood.com/instruments/?symbol=X` → instrument URL
- `POST https://api.robinhood.com/orders/` — market, gfd, account=605420660
- `submitRobinhoodOrder()` (MCP) is NOT called — requires live MCP session context unavailable in serverless

### India execution path

Calls `placeEquityOrder()` from `lib/kite.ts` directly — same REST path as the owner-click flow.
Note: requires fresh daily Kite token; if stale, order = unknown_needs_reconcile.

### Budget reservation

Uses `reserve_live_order_budget_v2` with `p_execution_actor='autonomous_worker'` which sets `approved_by_user=false`.

### Missing migration 139 column fix

`trade_proposals.market` was not added by migration 139 but IS written by autonomous-shadow.ts — shadow cron inserts fail. Migration 141 adds it.

---

## 12. What Claude must not do

- Do not implement the old direct `submitRobinhoodOrder()` branch.
- Do not use `605420606`; it is wrong.
- Do not remove the deployment kill flag.
- Do not build PA3 before PA1/PA2 evidence and Vaibhav approval.
- Do not use market-data/portfolio fallbacks on autonomous money paths.
- Do not duplicate the Gateway’s checks in TraderAgent; extract and reuse one kernel.
- Do not call a same-app HTTP route internally for execution.
- Do not enable autonomous BUY without live exit and reconciliation.
- Do not mutate caps, lifecycle, account, or code through any LLM/tool loop.
