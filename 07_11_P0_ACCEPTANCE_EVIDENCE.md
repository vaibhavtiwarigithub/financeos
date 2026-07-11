# 07_11 Phase A (P0) + Phase B — Acceptance Evidence

Raw gate outputs + DB privilege/schema assertions for the Phase A remediation of
`07_08_FULL_APP_REVIEW.md`, extended with the Phase B batch (A3 injected-failure
test, A2 identity/allowlist hardening, A4 read-only report, A5 tz-boundary proof,
edge-fn deletion). Companion to `07_11_CLAUDE_FULL_APP_FIX_LOG.md`.

- **Base review commit:** `cbf8617`
- **Live DB evidence captured:** 2026-07-11 (Supabase ref `dionkikgdmlaotvtbnfr` "Kairos")
- **Scope:** Phase A (A1, A3, A4 code; A5 migration) + Phase B (A2 additive
  hardening, A3 test, A4 report, A5 proof, cleanup). A2 canonical-path
  *unification* still deferred (see log).
- **Safety invariants held:** no real/preview/cancel/modify broker order placed
  during fix or test; `AUTONOMOUS_LIVE_ENABLED` / `live_auto_enabled` / any
  autonomous market mode left OFF; no applied migration edited; append-only
  ledgers untouched; trading account `605420660` unchanged, `965848641`
  read-only; new positions long-only.

---

## 1. Gate: `npx tsc --noEmit`

```
(exit 0 — no diagnostics)
```

Clean typecheck. No `any`-leak or signature-mismatch from the new
`KillSwitchContext` / `ExecuteOrderResult` shapes.

## 2. Gate: `npx vitest run` (full suite)

Phase A baseline:
```
 Test Files  31 passed | 1 skipped (32)
      Tests  243 passed | 6 skipped (249)
```

Phase B (after adding `tests/execute-order-ack.test.ts`):
```
 Test Files  32 passed | 1 skipped (33)
      Tests  247 passed | 6 skipped (253)
   Duration  10.38s
```

+4 tests vs Phase A (243 → 247), all in the new A3 durable-ACK integration file.
6 skipped are pre-existing long-running/integration skips, unchanged by this work.

### 2b. Focused: `npx vitest run tests/execute-order-ack.test.ts`

```
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Drives the REAL `executeApprovedOrder` (collaborators mocked) at `env:"paper"` to
isolate the submit→ACK-persist path:

| Case | Assertion | Result |
|---|---|---|
| ACK fails all 3 attempts | `ok:false`, `status:202`, `needs_reconcile:true`, `broker_order_id:"BRK-123"`; `submitOrder` called **once** (no resubmit); exactly 3 persist attempts; 1 CRITICAL `reportIssue` keyed `order-ack-persist-failed` | PASS |
| ACK succeeds on 2nd attempt | `ok:true`; one submit; retry stops at 2; no alert | PASS |
| ACK persists first try | `ok:true`; 1 attempt; no alert | PASS |
| Broker submit itself fails | `status:502`; one submit; no false success | PASS |

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

### 4e. A5 (Phase B) — v2 + v1 grantees re-verified via `aclexplode`

```sql
SELECT p.proname, r.rolname AS grantee
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
CROSS JOIN LATERAL aclexplode(p.proacl) a JOIN pg_roles r ON r.oid=a.grantee
WHERE p.proname IN ('reserve_live_order_budget','reserve_live_order_budget_v2')
  AND a.privilege_type='EXECUTE' ORDER BY 1,2;
```
```
reserve_live_order_budget    | postgres
reserve_live_order_budget    | service_role
reserve_live_order_budget_v2 | postgres
reserve_live_order_budget_v2 | service_role
```
Both RPCs still service-role/postgres only. `list_migrations` shows
`152_rpc_grant_and_session_fixes` tracked as version `20260711135037` — the
earlier "no tracker row" note was wrong and is corrected in the fix log.

### 4f. A5 (Phase B) — market-local session-date tz-boundary proof (read-only)

Replays the exact v2 body math (`(instant at time zone v_tz)::date` and
`v_day_start`) at boundary instants:

```
market | instant (UTC)        | naive_utc_date | v_local_date | v_day_start (UTC)   | differs
-------+----------------------+----------------+--------------+---------------------+--------
us     | 2026-07-11 00:00:00Z | 2026-07-11     | 2026-07-10   | 2026-07-10 04:00:00 | true
india  | 2026-07-10 20:00:00Z | 2026-07-10     | 2026-07-11   | 2026-07-10 18:30:00 | true
us     | 2026-07-11 13:30:00Z | 2026-07-11     | 2026-07-11   | 2026-07-11 04:00:00 | false
```

Row 1 is the exact bug the fix targets: a US live BUY at 20:00 ET (00:00 UTC next
day) — `current_date`/UTC would roll the daily-BUY budget to a fresh window
mid-session (`naive_utc_date=2026-07-11`), while `v_local_date` correctly holds
`2026-07-10` and `v_day_start=04:00Z` = midnight ET. India symmetric. Normal
mid-session ET shows no divergence. **Concurrency:**
`pg_advisory_xact_lock(hashtext(local_date:market:broker:env))` is taken *before*
the count/sum read, so concurrent live BUYs on the same market/broker/env/session
serialize on that xact lock (caps read under it); distinct markets/brokers hash
distinct and never block each other — lock-by-construction.

### 4g. A2 (Phase B) — `broker_accounts` allowlist state (fail-closed effect)

```sql
SELECT broker, account_number, market, role FROM broker_accounts ORDER BY market, broker;
```
```
robinhood | 605420660 | us | trading
robinhood | 965848641 | us | view_only
```
There is **no** `kite`/`india`/`trading` row. The new fail-closed gate in
`app/api/kite/order/route.ts` therefore **refuses every India live order** until
the owner explicitly inserts an allowlisted Kite trading account — the intended
posture (live-state changes are owner-only; India live is not in use). Columns
`active_account_india` (on `strategy_config`) and `broker`/`account_number`/
`market`/`role` (on `broker_accounts`) all confirmed present.

### 4h. A4 (Phase B) — current NAV drift the read-only report surfaces

```sql
WITH pos AS (SELECT market, sum(qty*coalesce(current_price,avg_cost)) mtm
             FROM paper_positions GROUP BY market)
SELECT p.market, p.cash_balance, p.nav, coalesce(pos.mtm,0) AS positions_mtm,
       p.cash_balance+coalesce(pos.mtm,0) AS expected_nav,
       abs(p.nav-(p.cash_balance+coalesce(pos.mtm,0))) AS drift
FROM paper_portfolio p LEFT JOIN pos ON pos.market=p.market ORDER BY p.market;
```
```
market | cash        | stored_nav | positions_mtm | expected_nav | drift
-------+-------------+------------+---------------+--------------+----------
india  | 406518.23   | 847199.53  | 389175.40     | 795693.63    | 51505.90
us     | 7473.90     | 9979.65    | 2567.03       | 10040.93     | 61.28
```
Both pools drift past tolerance (`max(0.01,|nav|·1e-6)`) — the residue of the old
`open_positions` corruption. The report at `GET /api/paper/nav-reconcile`
re-derives this read-only and returns `pools_drifted:2`, `all_reconciled:false`.
It performs zero writes; correcting the stale `nav` is a separate owner-approved
corrective event, deliberately not done here.

---

## 5. What is NOT proven here (honest remaining risk)

- **No live end-to-end order path exercised.** By constraint, no real broker
  order was placed/previewed/canceled/modified. A3's durable-ack retry + 202
  `needs_reconcile` path is now covered by an injected-failure integration test
  (§2b) against the real function, but the DB failure is injected through the
  mock, not against live Postgres, and no live-broker round-trip was run.
- **A2 unification not done.** The standalone Kite path
  (`app/api/kite/order/route.ts`) now enforces the same identity/allowlist floor
  as the canonical path (§4g), but the two India live code paths still coexist;
  collapsing them into one service changes the order contract/UX and needs
  architecture approval (flagged in the fix log).
- **A4 drift not corrected.** The report makes the two drifted pools visible
  (§4h) but does not mutate them; correction is a separate owner-approved event.
- **A5 concurrency** is argued by lock placement (§4f), not an executed
  parallel-load test against a live broker.
- **Edge-function kill-switch copy deleted** — no longer a standing risk; the
  live path uses `lib/kill-switches.ts` exclusively.
