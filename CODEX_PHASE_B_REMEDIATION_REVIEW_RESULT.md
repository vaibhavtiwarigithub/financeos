# Phase B P0 remediation adversarial review — 2026-07-11

Reviewed commit range `4b7f75b..bee8d61` against current source and deployed FinanceOS Supabase project `dionkikgdmlaotvtbnfr`. Database verification was SELECT-only.

## 1. Executive verdict

**Phase B is not ready to be accepted as closing A2/A5.** A3's shared durable-ACK implementation is real and the focused test exercises it honestly, subject to coverage limitations below. A4's reconciliation route is owner-gated and read-only. Migration 152 is applied, its timezone conversion is correct across US DST boundaries, and browser roles can no longer execute v1/v2.

Two live-money issues remain:

1. **CRITICAL:** migration 152 partitions its advisory lock by broker, but the protected count/sum is market-wide and does not filter broker. Concurrent orders for two brokers in one market can acquire different locks, both observe the same pre-order total, and exceed the market daily cap.
2. **CRITICAL:** the Kite gate does not verify that the connected Kite access token belongs to `active_account_india`. It only verifies that the configured text value has an allowlist row. The canonical/autonomous Kite path bypasses the new route block and performs the same incomplete text-only check. Once a Kite allowlist row is added, a token for a different Zerodha identity can still receive the order.

Current live data has no Kite allowlist row, so India live orders are presently blocked. That reduces immediate exposure but does not make the implementation correct for the intended enabled state.

## 2. Ranked findings

| Rank | Severity | Area | Finding | File:line | Concrete fix |
|---:|---|---|---|---|---|
| 1 | CRITICAL | A5 daily budget concurrency | The lock key includes `p_broker`, but the count/sum covers every broker in the market. Two same-market BUYs routed to different brokers take different locks and can jointly exceed the market-wide cap. | `supabase/migrations/152_rpc_grant_and_session_fixes.sql:119-143` | Add a new migration replacing v2. If caps are market-wide, lock only `local_date:market:env` (recommended). If caps are broker-scoped, also filter `broker=p_broker` and make caps explicitly broker-scoped. Add a two-transaction concurrency integration test. |
| 2 | CRITICAL | A2 Kite account identity | The new block validates only `strategy_config.active_account_india` against `broker_accounts`; it never calls Kite `/user/profile` or compares the authenticated token's `user_id` to the selected account. A valid allowlist row plus a token for another account reaches the broker. | `app/api/kite/order/route.ts:82-112`, `lib/kite.ts:44-54`, `app/api/kite/status/route.ts:19-24` | Add a shared `resolveAndVerifyKiteTradingAccount(svc)` that reads config/allowlist, calls `/user/profile`, and requires returned immutable Kite `user_id` to equal the selected account. Call it immediately before wire submission as defense in depth. Store/compare `user_id`, not display name/email. |
| 3 | HIGH | A2 path coverage | The inserted standalone-route gate is not universal. `executeApprovedOrder()` can select the Kite adapter, and autonomous-live/live-exit callers reach it without executing `app/api/kite/order/route.ts:82-112`. The canonical resolver repeats only the same text allowlist lookup; the Kite adapter performs no account verification. | `lib/trading/execute-order.ts:34-57,153-208,340`; `lib/brokers/adapters/kite.ts:10-35`; `lib/trading/autonomous-live.ts:269-272,398-420`; `lib/trading/live-exit-monitor.ts:146` | Put the shared verified Kite identity resolver in the canonical gateway and Kite adapter, then make the standalone route delegate to `executeApprovedOrder`. Until unified, both paths must call the same resolver. Add tests proving manual, autonomous, and protective-exit paths all fail before reservation when token identity mismatches. |
| 4 | HIGH | A5 input validation | The function claims positive **finite** numeric validation but accepts PostgreSQL numeric `Infinity`: it is not NaN and is greater than zero. It also does not validate `p_side`, `p_broker_env`, nonempty broker/symbol/order type, or nonnegative finite caps. A malformed side such as `BUY` bypasses BUY cap logic and is inserted. | `supabase/migrations/152_rpc_grant_and_session_fixes.sql:70-107,126-157` | New migration: reject `p_qty`/notional/caps unless finite; require side `buy|sell`, env `live|paper`, nonempty allowlisted broker/symbol/order type, integer qty where brokers require it, and sane nonnegative caps. Add direct RPC integration tests using service role. |
| 5 | MED | A3 test honesty | The test proves the shared post-submit ACK loop for its mocked paper path, but the evidence language is broader than its assertions. It does not run the live gate/account/reservation path, does not assert the CRITICAL alert detail contains the known broker ID, and the fourth test says “no ACK attempts” without asserting the attempt count. A hypothetical resubmit added only inside a live-only branch would still pass. | `tests/execute-order-ack.test.ts:9-12,114-183`; `07_11_P0_ACCEPTANCE_EVIDENCE.md:52-64` | Add a live-path test with all gates mocked to pass and assert exactly one submit, three ACK projection writes, 202, broker/order IDs in both result and alert detail. In the broker-reject test expose/assert ACK-attempt count separately from failure-status updates. |
| 6 | LOW | A2 documentation/contract | “Without changing the request/response contract” is too broad: the route intentionally changes previously successful owner requests into 403/500 until account selection/allowlisting succeeds. The JSON request shape is unchanged, but behavior/error contract changed. | `07_11_CLAUDE_FULL_APP_FIX_LOG.md:82-99`; `app/api/kite/order/route.ts:91-110` | Say “request shape unchanged; authorization behavior intentionally tightened.” Document new 403/500 cases for the UI. |

## 3. Money-path integrity, gate by gate

### A2 — standalone Kite route

1. **Owner and CSRF gate: clean.** `requireOwner()` is awaited and returned at `app/api/kite/order/route.ts:20-22`; `guardOrderRequest()` follows before body processing.
2. **Confirmation/idempotency/input checks: clean for the reviewed change.** They occur before service-role work at lines 31-54.
3. **Trading/kill gate: pre-existing and before A2.** No reservation or broker POST occurs here. It can read risk data, but that is not money mutation.
4. **New config lookup: fail-closed.** `acctCfgErr` returns 500; null account returns 403 at lines 91-99.
5. **New allowlist lookup: fail-closed.** `allowErr` returns 500; absent/wrong role returns 403 at lines 100-111.
6. **Multiplicity: clean.** Deployed/repo schema has unique `(broker, account_number)` (`supabase/migrations/093_robinhood_mcp_scaffolding.sql:13-22`), so the three-filter `.maybeSingle()` cannot legitimately return multiple rows. Duplicate corruption would produce an error and the route returns 500.
7. **Placement before money: clean.** v1 reservation is at lines 232-252 and `placeEquityOrder()` at 254-261, both after the new block.
8. **Actual identity binding: failed.** The route never proves the live Kite session belongs to the allowlisted configured account. `app/api/kite/status` already demonstrates that `/user/profile` can be called, but it currently retains only name/email rather than the immutable `user_id`.
9. **Alternate paths: failed.** Canonical `executeApprovedOrder()` and its autonomous/exit callers can submit through `kiteAdapter()` without traversing this route. They perform a logical allowlist lookup but no connected-session identity binding.
10. **Current deployed state:** only two Robinhood rows exist; no Kite row. Therefore all reviewed standalone/canonical Kite live paths fail at allowlist/account resolution today. The defect becomes active when the owner adds the intended Kite trading row.

### A5 — budget RPC

1. **Migration application: clean.** `supabase_migrations.schema_migrations` contains tracked version `20260711135037`.
2. **Signature/caller compatibility: clean.** Deployed v2 signature remains `(bigint,text,text,text,text,text,numeric,text,numeric,numeric,text,integer,numeric,text)`, matching `execute-order.ts:323-330`. v1 remains callable by the service-role Kite route.
3. **Privileges: clean.** Deployed `has_function_privilege` is false for anon/authenticated and true for postgres/service_role for both v1 and v2.
4. **Timezone math: clean.** Read-only live SQL produced:
   - US spring-forward day start `2026-03-08 05:00:00+00`; next midnight `2026-03-09 04:00:00+00` (23-hour day).
   - US fall-back day start `2026-11-01 04:00:00+00`; next midnight `2026-11-02 05:00:00+00` (25-hour day).
   - India `2026-07-11` midnight = `2026-07-10 18:30:00+00`.
   These are correct UTC instants for local midnight.
5. **Same-key transaction serialization: clean.** `pg_advisory_xact_lock` is acquired before the count/sum, and PL/pgSQL runs inside the RPC transaction.
6. **Lock/query scope agreement: failed.** Lock is market+broker+env, query is market+live env. Different broker locks do not serialize a shared market-wide total.
7. **Input validation: partial/fail-open for malformed service inputs.** Market/currency, actor, positive ordinary qty, and positive ordinary live-BUY notional reject correctly. Positive numeric Infinity and unrecognized side/env/broker/symbol do not.

### A3 — durable acknowledgment

The production ACK loop is after `broker.submitOrder()` and outside the `env === live` block (`lib/trading/execute-order.ts:340-387`), so the same retry/202 logic runs for paper and live. The test imports the real function and its resolver forces the actual `broker_orders.update(ackPayload).eq(id)` to fail/succeed. The three-attempt bound comes from production lines 369-374, not the test. `submitOrder` exactly-once assertion is meaningful for the shared code path.

The test does not prove the live gates, real Supabase/PostgREST behavior, adapter-specific ambiguity, or alert payload completeness. Those limitations are partially acknowledged in the fix log, but the acceptance evidence should not imply full live-path integration coverage.

### A4 — NAV reconciliation

**Clean for the requested properties.** `GET` returns `requireOwner()` failures, uses two SELECTs only, invokes no RPC, and performs no insert/update/upsert/delete. Market bucketing defaults null market to `us`, matching PositionMonitor's legacy default. It uses `current_price ?? avg_cost`, not truthiness, and tolerance matches the documented formula. It may report malformed numeric data as non-finite/JSON-null rather than a structured data error, but that is outside the money path and does not contradict read-only behavior.

### Cleanup — deleted edge-function copy

**Clean.** Repository search found no import/reference to `supabase/functions/_shared/kill-switches.ts`. Current app kill-switch callers import `@/lib/kill-switches`. No dangling edge-function import was found.

## 4. Test-honesty audit

### What the A3 test genuinely proves

- It imports and executes the real `executeApprovedOrder()`.
- Broker success followed by three projection-update errors returns `ok:false`, status 202, `needs_reconcile:true`, and the known DB/broker IDs.
- Production code performs exactly three DB-only ACK attempts in this test shape.
- Production code does not call `broker.submitOrder()` again inside the shared ACK retry loop.
- Transient success on attempt two stops retrying.

### What it does not prove

- That the live-only branch reaches the same block after real account, quote, G1/G3, kill-switch, and v2 RPC behavior.
- That a future resubmit mistakenly added only inside `if (orderEnv === "live")` is caught; the paper test would still pass.
- That the alert detail carries the broker ID, proposal, and “do not resubmit” instruction; only severity and issue-key substring are asserted.
- That Supabase update errors have the same shape as the hand-built mock.
- That adapter-specific ambiguous success/failure states are normalized correctly.
- The fourth test's stated “no ACK attempts”: it never reads/asserts `attempts()`, and its resolver counts any `broker_orders` update, including the expected error-status write.

Scoped verification performed now:

```text
npx vitest run tests/execute-order-ack.test.ts
Test Files 1 passed; Tests 4 passed

npx tsc --noEmit
Exit code 0
```

## 5. What could not be verified

- No real Kite/Robinhood order was placed, previewed, canceled, or modified.
- No Kite access token/profile was inspected. Therefore the exact live Kite `user_id` response shape should be confirmed read-only before implementing the identity comparison.
- A true two-session database concurrency test was not executed because the review was constrained to SELECT-only database access. The lock/query mismatch is nevertheless deterministic from the deployed function definition.
- RPC rejection cases were not invoked because even a failing SECURITY DEFINER RPC could perform writes if validation order regressed. Input findings were verified from source/deployed definition plus read-only PostgreSQL numeric comparison (`'Infinity'::numeric` is positive, not NaN).
- The full suite/build was not rerun; the new focused suite and TypeScript check passed. Companion evidence records its earlier full-suite/build run.
- No browser UI exercise was required by this scoped prompt.

---

## 6. Remediation applied — 2026-07-11 (Claude, commit range after `bee8d61`)

All six findings remediated. No real broker order was placed, previewed, canceled, or modified during remediation; autonomous/live state left OFF; every schema change is a new additive migration; no append-only ledger rewritten.

| # | Sev | Fix shipped | Where |
|---:|---|---|---|
| 1 | CRITICAL | Migration **153** `CREATE OR REPLACE reserve_live_order_budget_v2`: advisory-lock key dropped `p_broker` → now `hashtext(local_date:market:env)`, matching the market-wide count/sum scope. Two same-market cross-broker BUYs now serialize on one lock. | `supabase/migrations/153_budget_rpc_lock_scope_and_input_hardening.sql` |
| 2 | CRITICAL | `verifyKiteTradingIdentity()` calls Kite `/user/profile` and requires the immutable returned `user_id` to equal `active_account_india`; text-allowlist check retained as an additional gate. Compares `user_id`, never display name/email. Fail-closed. | `lib/kite.ts` |
| 3 | HIGH | Identity verification moved to the `placeEquityOrder` choke point in `lib/kite.ts` — every programmatic Kite submit (standalone route, canonical `executeApprovedOrder` → Kite adapter, autonomous-live, live-exit) crosses it before wire submission. | `lib/kite.ts`, `app/api/kite/order/route.ts` |
| 4 | HIGH | Migration **153** rejects non-finite `p_qty`/notional/caps (`Infinity`/`-Infinity`/`NaN`), and validates `p_side in (buy,sell)`, `p_broker_env in (live,paper)`, non-empty broker/symbol/order_type; live BUY requires positive finite notional. | `supabase/migrations/153_budget_rpc_lock_scope_and_input_hardening.sql` |
| 5 | MED | Added `A3 durable broker acknowledgment — LIVE path` test: all gates mocked to pass, asserts exactly one `submitOrder`, three ACK projection writes (`attempts()===3`), 202 `needs_reconcile`, broker+order IDs in result, CRITICAL alert whose detail contains the broker order id. Broker-reject test now asserts `attempts()===1` (the single failure-status write, not an ACK retry). | `tests/execute-order-ack.test.ts` |
| 6 | LOW | Fix-log wording corrected: "request *shape* unchanged (same params in, same JSON out), authorization behavior intentionally tightened; previously-accepted requests may now be refused (403/500/502) — that stricter outcome is the point of the fix." | `07_11_CLAUDE_FULL_APP_FIX_LOG.md` |

Migration 153 verified applied to deployed project (`list_migrations`) before shipping schema-coupled code.

Gates after remediation:

```text
npx tsc --noEmit            → exit 0
npx vitest run              → 32 files passed, 1 skipped; 248 tests passed, 6 skipped
npm run build               → success (all routes compiled)
```

Companion diagram/doc updates in the same change: `docs/arch/08-risk-and-safety.md` (verified-identity gate, lock-scope, input hardening) and `public/agent-diagrams/system-map.json` (KITE node choke-point description + history entry; also repaired 8 pre-existing raw control chars in the `diagram` string that made the file unparseable).
