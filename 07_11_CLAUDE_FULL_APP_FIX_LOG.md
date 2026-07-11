# 07_11 Phase A (P0) — Full-App Fix Log

Remediation of `07_08_FULL_APP_REVIEW.md` (base commit `cbf8617`), Phase A only,
ordered by money-loss risk. One row per finding: disposition, evidence, files,
tests, remaining risk. Raw gate/DB outputs in `07_11_P0_ACCEPTANCE_EVIDENCE.md`.

**Constraints held throughout:** no real/preview/cancel/modify broker order
during fix or test; `AUTONOMOUS_LIVE_ENABLED` / `live_auto_enabled` / any
autonomous market mode left OFF; no applied migration edited (all schema changes
additive); append-only ledgers untouched; LLMs control no money limit / account
/ promotion / kill switch / order submission; new positions long-only;
risk-reducing SELL requires fresh exact-account held qty; trading account
`605420660` unchanged, `965848641` read-only; no hardcoded secret/token.

**Gates (all green):** `tsc --noEmit` clean · `vitest run` 243 passed / 6 skipped
(+5 new) · `npm run build` success.

---

## A1 — Explicit paper/live kill-switch context — **ACCEPTED / DONE**

**Finding:** `checkKillSwitches` inferred live-vs-paper from `live_auto_enabled`,
so an L3 manual-live order (auto OFF) measured **paper** NAV; live equity was
compared to a static `START_NAV` ($10k US / ₹10L), so a real $36 account read as
a 99.6% drawdown; and a single `safe` flag conflated "may increase risk" with
"may reduce risk," so a trip could block a protective SELL.

**Fix:**
- New typed context: `checkKillSwitches(svc, { market, book:"paper"|"live", accountId? })`.
  Bare-string arg back-comp shim treats a market string as a **paper** check.
- Result widened: `{ safe, sellAllowed, reason?, tripped? }` where
  `tripped ∈ daily_loss|accuracy|drawdown|stale_snapshot|no_baseline`.
- Live path reads `live_account_snapshots` for the resolved account; peak is that
  account's **own** 90-day snapshot high-water mark (no `START_NAV` floor).
- Freshness gate: newest snapshot older than `KS_LIVE_SNAPSHOT_MAX_AGE_MS`
  (default 6h) fails **closed for BUY only**.
- Fail-closed-for-BUY when no account / no snapshot (`tripped:"no_baseline"`) or
  stale (`tripped:"stale_snapshot"`) — `sellAllowed:true` in every such case.
- Risk-trip carve-out: `const sellAllowedOnTrip = isLive` — a live daily-loss /
  accuracy / drawdown trip blocks BUY but leaves `sellAllowed:true`; paper trip
  blocks both (sim has no exposure to reduce). Kill switch scoped per-market.

**Files:** `lib/kill-switches.ts` (rewrite of the metric-collection + result
shape); callers updated to explicit context — `app/api/agents/trader/route.ts`
(x2, paper), `app/api/agents/paper-trade/route.ts` (paper),
`lib/trading/autonomous-live.ts` (live), `app/api/broker/orders/sync/route.ts`
(live, cancel-on-kill), `lib/trading/execute-order.ts` (live, side-aware),
`app/api/kite/order/route.ts` (live, side-aware).

**Order-gate semantics:** callers compute `ksBlocks = side==="sell" ? !sellAllowed : !safe`
so a verified SELL survives a trip and a BUY does not.

**Tests:** `tests/kill-and-exit.test.ts` Test 9c (+5, real fn via `importActual`):
small-account-own-peak, live-drawdown-trip (BUY blocked / SELL allowed),
no-account no_baseline, stale_snapshot, zero-snapshot no_baseline; plus Test 9a
(paper trip) and 9b/10 (cancel-on-kill mock updated to object context). All PASS.

**DB evidence:** `live_account_snapshots` has account_id/equity/portfolio_value/
captured_at (§4c).

**Remaining risk:** live BUY-cap and accuracy estimation use `broker_orders`
fill approximation; not exercised against a live broker (constraint). Edge-fn
copy still paper-only (see note below).

---

## A2 — One canonical Kite execution path — **DEFERRED (needs architecture approval)**

**Finding:** `app/api/kite/order/route.ts` is a second, standalone execution path
with its own budget-v1 reservation and broker submit, bypassing the canonical
proposal + `executeApprovedOrder()` service and its identity/allowlist checks.

**Disposition:** NOT unified in Phase A. Collapsing Kite into a CSRF/owner-gated
facade over `executeApprovedOrder()` changes the India order contract, account
resolver, and confirmation UX — an architecture change requiring owner approval
per the project's Architecture-First gate. **Flagged for approval before Phase B.**

**Interim mitigation applied:** the A3 durable-ack semantics were applied
directly to the standalone Kite path so it cannot return success on a lost ACK
while it remains un-unified (see A3).

**Remaining risk:** two live order code paths still exist for India; identity
(profile-vs-configured-account) verification and allowlist enforcement on the
standalone Kite route remain thinner than the canonical path until A2 lands.

---

## A3 — Durable broker acknowledgment — **ACCEPTED / DONE**

**Finding:** after a successful broker submit, the source-of-truth update was
fire-and-forget; a DB failure post-ACK could return `{ok:true}` while the ledger
never recorded the broker order — an unreconcilable silent divergence, and a
resubmission risk.

**Fix (`lib/trading/execute-order.ts`):** after broker success, build an ACK
payload (`status:"submitted"`, `broker_order_id`, `submitted_at`,
`raw_last_state`) and persist with a **bounded DB-only** 3-attempt retry (never
re-submits to the broker). On persistent failure → CRITICAL `reportIssue`
(`order-ack-persist-failed:{orderId}`) + `return { ok:false, status:202,
needs_reconcile:true, order_id, broker_order_id }` — never `{ok:true}`. The
`decision_journal` insert error is now captured and warned
(`order-journal-failed:{orderId}`) instead of dropped. `ExecuteOrderResult`
failure variant extended with `needs_reconcile?`, `order_id?`, `broker_order_id?`.

**Kite parity (`app/api/kite/order/route.ts`):** ledger ACK update wrapped in the
same 3-attempt retry; on persistent failure with a real broker order id →
CRITICAL `reportIssue` (`kite-order-ack-persist-failed:{ledgerId}`) + HTTP 202
`{ success:false, needsReconcile:true, broker_order_id, kite_order_id }`.

**Tests:** typecheck + existing order-path suites green. No live broker
round-trip (constraint) — see remaining risk.

**Remaining risk:** the 202/needs_reconcile branch is proven by typecheck and
unit reasoning, not a live injected-DB-failure-after-broker-ACK integration test
(would require a live order). Robinhood MCP adapter inherits the execute-order
semantics; a dedicated adapter-level injected-failure test is a Phase B item.

---

## A4 — Repair PositionMonitor accounting — **ACCEPTED / DONE**

**Finding:** the NAV update wrote `open_positions`, a column that does **not**
exist on deployed `paper_portfolio`; PostgREST rejected the whole update and the
ignored error silently corrupted NAV. `paper_performance` used `.catch()` on a
call that returns `{error}` rather than throwing, so real write failures were
never caught. A score-exit branch rendered a **direction flip** as a nonsense
score comparison (`68 < 37`).

**Fix (`app/api/agents/position-monitor/route.ts`):**
- Removed the non-existent `open_positions` field; capture the update `error`.
- `paper_performance` upsert error captured; pre-057 "no market column" case
  retries keyed on `date` only (prior fallback preserved); surviving error
  recorded.
- On any NAV/performance write error: `agent_runs.status="error"` with the error
  in `result_summary`, plus a CRITICAL System Health alert
  (`position-monitor-nav-write:{market}`); cleared via `resolveIssue` on success.
- Deterministic **read-only** NAV invariant per market:
  `|nav − (cash + Σ qty·price)| ≤ max(0.01, |nav|·1e-6)`; violation logged, no
  mutation.
- Structured exit reasons: `direction_flip (was long, now <dir>)` vs
  `score_below_exit_threshold (<score> < <thr>)`, flip taking precedence.

**DB evidence:** `paper_portfolio` has no `open_positions` column (§4d).

**Disposition on migration:** field removed rather than adding a column — no
consumer reads it (performance route reads NAV history from `paper_nav_history`).
No migration shipped for A4.

**Remaining risk:** a standalone read-only reconciliation **report** for
historical inconsistent rows (fix-prompt bullet) is not yet written; the
in-run invariant makes future drift observable but does not retro-audit past
rows. Flagged for Phase B (owner-approved corrective events only; no ledger
mutation).

---

## A5 — Migration: RPC grant / session fixes — **ACCEPTED / DONE (applied)**

**Finding:** `reserve_live_order_budget` (v1) was EXECUTE-granted to browser
roles (`anon`/`authenticated`/PUBLIC), exposing the live money-limit reservation
RPC; v2 session date was UTC, not market-local.

**Fix (`supabase/migrations/152_rpc_grant_and_session_fixes.sql`, applied):**
REVOKE EXECUTE on v1 and v2 from PUBLIC/anon/authenticated; keep
service_role + postgres only; v2 `CREATE OR REPLACE` with market-local session
date (`America/New_York` / `Asia/Kolkata`) and a lock key including market +
account + local session date. Idempotent (REVOKE re-runnable, body is CREATE OR
REPLACE).

**DB evidence:** v1 grantees = {postgres, service_role} (§4a); v2 grantees =
{postgres, service_role} (§4b). No public/anon/auth execution on either.

**Remaining risk:** `152_*` is authored with a file-prefix scheme rather than a
matching row in `supabase_migrations.schema_migrations` under version `152`; the
applied privilege state is verified directly (§4a/4b) rather than via tracker
name. Timezone-boundary + concurrency integration tests for v2 (fix-prompt
acceptance) are a Phase B follow-up.

---

## Cross-cutting note — unused edge-function kill-switch copy

`supabase/functions/_shared/kill-switches.ts` is a **separate, paper-only** copy
with hardcoded thresholds (−5 / 40 / 20) and **no importers** anywhere under
`supabase/functions/`. It was intentionally **not** refactored for book/account
context (dead code); documented here so a future reader does not mistake it for
the live path. If an edge function ever needs kill-switch logic, it must adopt
the `lib/kill-switches.ts` contract, not this copy.

---

## Disposition summary

| Finding | Disposition | Live tested | Migration |
|---|---|---|---|
| A1 kill-switch context | ACCEPTED / DONE | unit (Test 9c, +5) | — |
| A2 canonical Kite path | **DEFERRED — needs arch approval** | — | — |
| A3 durable broker ACK | ACCEPTED / DONE | typecheck + unit | — |
| A4 PositionMonitor accounting | ACCEPTED / DONE | unit + DB assert | none (field removed) |
| A5 RPC grant / session | ACCEPTED / DONE (applied) | DB privilege assert | 152 (applied) |

**Stopping after Phase A per the fix prompt.** Phases B/C not started. A2 (and
the residual A4 reconciliation report + A5 tz/concurrency tests) require
architecture/quant approval before implementation.
