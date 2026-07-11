# 07_11 Phase A (P0) — Acceptance Evidence

Raw gate outputs + DB privilege/schema assertions for the Phase A remediation of
`07_08_FULL_APP_REVIEW.md`. Companion to `07_11_CLAUDE_FULL_APP_FIX_LOG.md`.

- **Base review commit:** `cbf8617`
- **Live DB evidence captured:** 2026-07-11 (Supabase ref `dionkikgdmlaotvtbnfr` "Kairos")
- **Scope:** Phase A only (A1, A3, A4 code; A5 migration). A2 deferred (see log).
- **Safety invariants held:** no real/preview/cancel broker order placed during
  fix or test; `AUTONOMOUS_LIVE_ENABLED` / `live_auto_enabled` left OFF; no
  applied migration edited; append-only ledgers untouched; trading account
  `605420660` unchanged, `965848641` read-only.

---

## 1. Gate: `npx tsc --noEmit`

```
(exit 0 — no diagnostics)
```

Clean typecheck. No `any`-leak or signature-mismatch from the new
`KillSwitchContext` / `ExecuteOrderResult` shapes.

## 2. Gate: `npx vitest run` (full suite)

```
 Test Files  31 passed | 1 skipped (32)
      Tests  243 passed | 6 skipped (249)
   Duration  6.89s
```

+5 tests vs the pre-Phase-A baseline (238 → 243), all in Test 9c (new A1
live-path acceptance cases). 6 skipped are pre-existing long-running/integration
skips, unchanged by this work.

### 2a. Focused: `npx vitest run tests/kill-and-exit.test.ts`

```
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

Test 9c — real `checkKillSwitches` (via `vi.importActual`, no re-implemented
logic) — asserts the A1 semantics directly:

| Case | Assertion | Result |
|---|---|---|
| Small live account ($36 vs own $40 peak) | drawdown 10% < 25% ⇒ `safe:true`; reads `live_account_snapshots`, never `paper_portfolio`/`paper_performance` | PASS |
| Live drawdown trip ($50 vs $100 peak) | `safe:false`, `tripped:"drawdown"`, `sellAllowed:true` | PASS |
| No live account configured | `safe:false`, `tripped:"no_baseline"`, `sellAllowed:true` | PASS |
| Stale live snapshot (10h > 6h max) | `safe:false`, `tripped:"stale_snapshot"`, `sellAllowed:true` | PASS |
| Live account, zero snapshots | `safe:false`, `tripped:"no_baseline"`, `sellAllowed:true` | PASS |

These encode the two doctrine carve-outs: (1) a live risk trip blocks BUY but
never a verified SELL; (2) a data-freshness fail-close blocks BUY only.

## 3. Gate: `npm run build`

```
✓ Compiled successfully
(full route table rendered; middleware 90.5 kB; no build error)
```

---

## 4. DB privilege / schema assertions (live Supabase, 2026-07-11)

### 4a. A5 — legacy budget RPC grant revoked from browser roles

```sql
SELECT p.proname, r.rolname AS grantee
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
LEFT JOIN LATERAL aclexplode(p.proacl) a ON true
LEFT JOIN pg_roles r ON r.oid=a.grantee
WHERE p.proname='reserve_live_order_budget' AND n.nspname='public';
```
```
reserve_live_order_budget | postgres
reserve_live_order_budget | service_role
```
`PUBLIC` / `anon` / `authenticated` absent ⇒ browser roles can no longer execute
the money-limit reservation RPC.

### 4b. A5 — v2 RPC identically locked down

```
reserve_live_order_budget_v2 | postgres
reserve_live_order_budget_v2 | service_role
```
A future `CREATE OR REPLACE` default-grant-to-PUBLIC cannot silently reopen it —
the migration pins the revoke on v2 as well.

### 4c. A1 — live NAV source table present with required columns

```sql
SELECT count(*) FROM information_schema.columns
WHERE table_name='live_account_snapshots'
  AND column_name IN ('account_id','equity','portfolio_value','captured_at');
-- => 4
```
All four columns `getLiveNavSeries()` reads exist ⇒ the live kill-switch path is
schema-backed, not reading a phantom table.

### 4d. A4 — deployed `paper_portfolio` has NO `open_positions` column

```sql
SELECT count(*) FROM information_schema.columns
WHERE table_name='paper_portfolio' AND column_name='open_positions';
-- => 0
```
Confirms the root cause: the old update named `open_positions`, a non-existent
column, so PostgREST rejected the **entire** NAV update and the ignored error
silently corrupted NAV. A4 removes the field (nothing reads it) rather than
adding a migration, and now captures the write error.

---

## 5. What is NOT proven here (honest remaining risk)

- **No live end-to-end order path exercised.** By constraint, no real broker
  order was placed/canceled. The durable-ack (A3) retry + 202 `needs_reconcile`
  path is covered by unit reasoning and typecheck, not a live broker round-trip.
- **A2 not done.** The standalone Kite order path
  (`app/api/kite/order/route.ts`) still exists un-unified; A3 durable-ack was
  applied to it directly as an interim measure. Facade unification needs
  architecture approval (flagged in the fix log).
- **Edge-function copy of kill-switches** (`supabase/functions/_shared/
  kill-switches.ts`) is UNUSED (no importer) and still paper-only with hardcoded
  thresholds; documented, not refactored.
- **Migration version tracker:** `152_*` is authored with a `152` file prefix;
  the applied grant/RPC state is verified directly above (§4a/4b) rather than by
  a tracker-name match.
