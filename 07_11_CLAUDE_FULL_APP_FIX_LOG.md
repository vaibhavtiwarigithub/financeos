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

**Phase B — additive identity/allowlist gate (`app/api/kite/order/route.ts`):**
without changing the request/response contract, a fail-closed identity check was
added before the budget reservation, mirroring `resolveTradingAccount` in the
canonical `execute-order.ts`. It reads `strategy_config.active_account_india` and
requires a matching `broker_accounts` row (`broker='kite'`, `market='india'`,
`role='trading'`). It refuses (403/500) on: config read error, no active India
account set, account absent from `broker_accounts`, or a `view_only` role — never
a silent fallback. This closes the identity/allowlist gap flagged above. **Note
the current fail-closed effect:** `broker_accounts` today holds only the two US
Robinhood rows (§4g), so there is NO allowlisted Kite/India `trading` row — the
India live path is therefore **blocked until the owner explicitly inserts one**.
That is the intended posture (live changes are owner-only; India live is not in
use). The canonical-path *unification* (collapsing the two India code paths into
one) still requires architecture approval and remains deferred.

**Remaining risk:** two live order code paths still exist for India (structural),
but the standalone route now enforces the same account allowlist/identity floor
as the canonical path. Full unification (single service, v2 RPC, shared
confirmation UX) awaits owner architecture approval.

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

**Tests:** typecheck + existing order-path suites green. **Phase B — injected-
failure integration test added** (`tests/execute-order-ack.test.ts`, 4 tests,
all green): drives the REAL `executeApprovedOrder` with a fake broker + chainable
Supabase mock at `env:"paper"` (skips the live-gate block to isolate the
submit→ACK-persist path). Cases: (1) ACK fails all 3 attempts → `ok:false`,
`status:202`, `needs_reconcile:true`, surfaces `broker_order_id:"BRK-123"`,
`submitOrder` called **exactly once** (no resubmit), exactly 3 persist attempts,
one CRITICAL `reportIssue` keyed `order-ack-persist-failed`; (2) ACK succeeds on
attempt 2 → `ok:true`, one submit, retry stops at 2, no alert; (3) ACK first try
→ `ok:true`, 1 attempt; (4) broker submit itself fails → `status:502`, no false
success. This directly exercises the durable-ACK invariant end-to-end without a
live broker round-trip.

**Remaining risk:** the test injects the DB failure through the mock rather than
against live Postgres; the Robinhood MCP adapter inherits the execute-order
semantics but a dedicated adapter-level injected-failure test remains a later
item. No live injected-failure-after-real-broker-ACK test exists (would require a
live order — disallowed by constraint).

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

**Phase B — read-only reconciliation report added** (`app/api/paper/nav-reconcile/route.ts`,
owner-gated GET, `force-dynamic`, no cron): re-derives the same invariant per
market pool read-only — `expected = cash_balance + Σ qty·(current_price ?? avg_cost)`,
`drift = |stored_nav − expected|`, `tol = max(0.01, |nav|·1e-6)` — and returns
per-pool `{cash, stored_nav, positions_mtm, expected_nav, drift, tolerance,
reconciled, overstated_by}` plus `pools_drifted` / `all_reconciled`. It performs
**zero writes**. Running the equivalent SQL now (§4h) shows **both** pools
currently off — US `stored_nav 9979.65` vs `expected 10040.93` (drift $61.28) and
India `stored_nav 847199.53` vs `expected 795693.63` (drift ₹51,505.90) — exactly
the historical corruption the removed `open_positions` write caused. The report
makes this visible without touching the ledger.

**Remaining risk:** the report surfaces drift but does not correct it — the two
drifted pools above still hold stale `nav`. Correction is a separate owner-
approved action (a corrective event / re-derivation), deliberately NOT done here:
append-only ledgers are not rewritten and NAV is not silently mutated.

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
Re-verified in Phase B (§4e): both functions still {postgres, service_role} only.

**Migration tracker:** `list_migrations` shows `152_rpc_grant_and_session_fixes`
tracked as version `20260711135037` in `supabase_migrations.schema_migrations`
— the earlier note claiming a bare file-prefix scheme with no tracker row was
wrong and is corrected here. Applied state is confirmed both by the tracker row
and directly by the grantee query (§4a/4b/4e).

**Phase B — tz-boundary proof (read-only, §4f):** the exact v2 session-date math
(`(now() at time zone v_tz)::date` and `v_day_start`) was replayed at boundary
instants. A US live BUY at 00:00 UTC (20:00 ET, same trading day) yields
`naive_utc_date = 2026-07-11` (a UTC rollover that `current_date` would have used
to reset the daily budget mid-session) but `v_local_date = 2026-07-10` with
`v_day_start = 2026-07-10 04:00Z` (= midnight ET) — the window correctly holds to
the market's own session day. India at 20:00 UTC (01:30 IST) is symmetric
(`v_local_date = 2026-07-11`, `v_day_start = 18:30Z` = midnight IST). A normal
09:30-ET instant shows no divergence. **Concurrency:** v2 serializes by
construction — `pg_advisory_xact_lock(hashtext(local_date:market:broker:env))` is
taken before the count/sum, so two concurrent live BUYs on the same
market/broker/env/session-day block on the same xact lock and the caps are read
under it; distinct markets/brokers hash to distinct keys and never serialize on
each other. This is a lock-by-construction argument, not a live concurrent-load
test (a live broker order is disallowed by the fix constraints).

**Remaining risk:** the concurrency guarantee is proven by the lock placement in
the function body, not by an executed parallel-load integration test against a
live broker (constraint). The v1 (14-arg) path used by the standalone Kite route
does NOT carry the market-local session date — it is only reached on the India
live path, now additionally identity/allowlist-gated (A2 interim, below), and is
scheduled to retire when A2 unifies onto the v2 service.

---

## Cross-cutting note — unused edge-function kill-switch copy

`supabase/functions/_shared/kill-switches.ts` was a **separate, paper-only** copy
with hardcoded thresholds (−5 / 40 / 20) and **no importers** anywhere under
`supabase/functions/`. **Phase B — deleted** (`git rm`; zero importers re-verified
under `supabase/` first) so no future reader mistakes it for the live path. If an
edge function ever needs kill-switch logic, it must adopt the `lib/kill-switches.ts`
contract (typed `{ market, book, accountId? }`), not resurrect this copy.

---

## Disposition summary

| Finding | Disposition | Live tested | Migration |
|---|---|---|---|
| A1 kill-switch context | ACCEPTED / DONE | unit (Test 9c, +5) | — |
| A2 Kite identity/allowlist | **HARDENED (additive); unification deferred** | unit path | — |
| A3 durable broker ACK | ACCEPTED / DONE | unit incl. injected-failure (4 tests) | — |
| A4 PositionMonitor accounting | ACCEPTED / DONE + read-only report | unit + DB assert | none (field removed) |
| A5 RPC grant / session | ACCEPTED / DONE (applied) | DB privilege + tz-boundary proof | 152 (applied, tracked) |

**Phase B (this batch) — completed under the owner's "go fix all" directive:**
- A3 injected-failure integration test (`tests/execute-order-ack.test.ts`, 4/4).
- A2 additive identity/allowlist gate on the standalone Kite route (contract
  unchanged; canonical-path *unification* still deferred to owner arch approval).
- A4 read-only NAV reconciliation report (`app/api/paper/nav-reconcile`).
- A5 tz-boundary read-only proof + advisory-lock concurrency argument (§4f);
  migration-152 tracker note corrected (tracked as `20260711135037`).
- Deleted the dead edge-fn kill-switch copy.

**Still owner-gated (not done here):** collapsing the two India live paths into a
single canonical service (A2 unification — changes India order contract/UX);
correcting the two currently-drifted NAV pools (a corrective event, not a silent
mutation). No live/autonomous trading was enabled; no real broker order was
placed, previewed, cancelled, or modified during this work.
