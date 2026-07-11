# Scoped Adversarial Review — 2026-07-11 Phase B P0 Remediation

You have READ access to this repository. **Ground every claim in `file:line`; verify against code,
not comments or docs.** This is a focused re-audit of the Phase B remediation of
`07_08_FULL_APP_REVIEW.md` — the code range `4b7f75b..bee8d61` (5 commits). The prior Phase A
(A1 kill-switch context, A3 durable ACK, A4 NAV-write-error fatal, A5 migration 152) is already on
`main`; Phase B adds a test, a fail-closed gate, a read-only report, an SQL proof, and a deletion.
Assume it has bugs. The A2 and A5 changes are on the LIVE-MONEY path. Find the bugs.

Write your report to `CODEX_PHASE_B_REMEDIATION_REVIEW_RESULT.md` (repo root, overwrite). Structure:
(1) exec verdict; (2) ranked findings table [rank | severity | area | finding | file:line | concrete
fix]; (3) money-path integrity, gate-by-gate; (4) test-honesty audit (does the A3 test actually prove
what the evidence doc claims?); (5) what you could not verify. Money/security findings outrank
everything. If an area is clean, say so in one line.

## Commit range under review

```
4b7f75b..bee8d61
  f961316  A3: injected-failure integration test for durable broker ACK (also DELETES supabase/functions/_shared/kill-switches.ts)
  880555d  A2: fail-closed identity/allowlist gate on standalone Kite order route
  d75d7ab  A4: read-only NAV reconciliation report route
  c41a066  A5: migration 152 — budget-RPC grant revoke + v2 market-local session date
  bee8d61  Docs(Phase B): fix log + acceptance evidence + WORK_LOG + arch-08
```

Companion docs whose claims you must independently verify against code:
`07_11_CLAUDE_FULL_APP_FIX_LOG.md`, `07_11_P0_ACCEPTANCE_EVIDENCE.md`.

## Scope — review these files/changes (and anything they touch)

**A2 — fail-closed identity/allowlist gate (highest scrutiny, live India path):**
- `app/api/kite/order/route.ts` — a new block was inserted AFTER the kill-switch gate and BEFORE the
  INR-cap / `reserve_live_order_budget` (v1) call. It reads `strategy_config.active_account_india`,
  then requires a matching `broker_accounts` row (`broker='kite'`, `account_number=<that>`,
  `market='india'`) whose `role='trading'`, else 403/500. Verify:
  1. The gate is genuinely fail-closed — any read error (`acctCfgErr`, `allowErr`) returns non-2xx and
     does NOT fall through to order submission. Confirm no early `svc` result is reused past an error.
  2. It cannot be bypassed: is there ANY other code path that submits a Kite/India live order without
     passing through this block? (grep for other kite order routes, cron callers, gateway delegation.)
  3. Placement is correct: does anything money-affecting (budget reservation, broker POST) happen
     BEFORE the gate? If the v1 `reserve_live_order_budget` insert or any broker call precedes it, the
     gate is cosmetic.
  4. Column/type reality: do `strategy_config.active_account_india` and `broker_accounts(broker,
     account_number, market, role)` exist with the assumed types? A `.maybeSingle()` on a non-unique
     match silently mis-gates — is the `broker_accounts` lookup guaranteed ≤1 row?
  5. Does this change the manual/owner Kite path's behavior or error contract in any way it should not?
     The fix log claims it is "additive, not a contract change" — confirm.

**A5 — migration 152 (live-money budget RPC):**
- `supabase/migrations/152_rpc_grant_and_session_fixes.sql` — (a) REVOKE EXECUTE on legacy v1
  `reserve_live_order_budget` from PUBLIC/anon/authenticated; (b) `CREATE OR REPLACE`
  `reserve_live_order_budget_v2` recomputing the daily-BUY window in market-local tz
  (`America/New_York` / `Asia/Kolkata`) instead of UTC `current_date`, widening the advisory-lock key
  to `local_date:market:broker:env`, and adding fail-closed input validation. Verify:
  1. Idempotency — safe to re-run (REVOKE + CREATE OR REPLACE). Does the REPLACE preserve the exact
     signature/arg order the callers use? A signature drift orphans callers.
  2. The tz math: `(now() at time zone v_tz)::date` and `v_day_start := (v_local_date::timestamp) at
     time zone v_tz`. Is `v_day_start` the correct UTC instant of market-local midnight for BOTH tzs,
     including a DST transition day? Walk one US spring-forward and one fall-back date.
  3. Advisory-lock correctness: `pg_advisory_xact_lock(hashtext(local_date:market:broker:env))` is taken
     BEFORE the count/sum read. Confirm the lock actually serializes concurrent same-session BUYs and
     that the count read it guards happens inside the same txn. Any read-before-lock TOCTOU?
  4. Does v1 still need to exist? The migration keeps v1 for the Kite path. Confirm the Kite route
     (`app/api/kite/order/route.ts`) still calls v1 and that revoking browser-role EXECUTE doesn't break
     the service-client call (service_role retained).
  5. Input validation fail-closed: malformed market / currency-market mismatch / non-finite qty/notional
     → does the function RAISE (reject) rather than silently reserve?
  6. Confirm the migration is actually applied to the target DB (the evidence doc claims tracked version
     `20260711135037`) — or flag if you can only see the file, not the applied state.

**A3 — durable-ACK integration test (test-honesty audit):**
- `tests/execute-order-ack.test.ts` — drives the REAL `executeApprovedOrder` at `env:"paper"` with
  mocked collaborators and a hand-rolled chainable Supabase mock. Verify the test is not self-fulfilling:
  1. Does it exercise the ACTUAL retry/needs-reconcile code in `lib/trading/execute-order.ts`, or does
     the mock shape let the function take a different branch than production? Specifically: is the "ACK"
     the same `broker_orders` UPDATE that production retries, and is the 3-attempt bound the function's,
     not the test's?
  2. The paper path is used to "isolate submit→ACK". Confirm the durable-ACK code is NOT live-gated —
     i.e. the same retry/202 logic runs for `env:"paper"` and `env:"live"`. If the retry only runs on
     the live branch, the test proves nothing about the live path.
  3. `broker.submitOrder` called exactly once on ACK failure — does the assertion actually pin "no
     resubmit", or could a resubmit occur on a code path the mock never reaches?
  4. Any assertion that passes vacuously (e.g. `toHaveBeenCalledTimes(1)` on a mock that the function
     structurally can only call once regardless of correctness)?

**A4 — read-only NAV reconciliation report:**
- `app/api/paper/nav-reconcile/route.ts` — owner-gated GET, `force-dynamic`, claims ZERO writes.
  Verify: (1) it truly performs no INSERT/UPDATE/UPSERT/RPC-with-side-effects; (2) `requireOwner()`
  actually blocks non-owners (not just returns a value the handler ignores); (3) the invariant matches
  position-monitor's (`nav == cash + Σ qty·(current_price ?? avg_cost)`, tol `max(0.01,|nav|·1e-6)`),
  per-market; (4) market bucketing can't cross US/India pools or double-count; (5) null/`undefined`
  `current_price` falls back to `avg_cost`, not to 0, matching the monitor.

**Cleanup — deleted edge-fn kill-switch copy:**
- Commit `f961316` deletes `supabase/functions/_shared/kill-switches.ts`. Confirm NOTHING under
  `supabase/functions/**` (or anywhere) still imports it, and that the live kill-switch path uses
  `lib/kill-switches.ts` exclusively. A dangling import = broken edge-function deploy.

## Specific things to try to break
1. A2: find a live India order path that reaches broker submission or v1 budget reservation WITHOUT
   passing the new allowlist block. If one exists, the gate is bypassable — report it.
2. A2: `broker_accounts` lookup via `.maybeSingle()` — if two rows can match (e.g. same account across
   markets, or a missing unique constraint), does it throw (fail-closed) or pick one (fail-open)?
3. A5: currency/tz — can a US order at a DST boundary get a WRONG `v_day_start` that resets or
   double-counts the daily BUY budget? Show the instant.
4. A5: does revoking v1 from `authenticated` break any browser-invoked RPC that legitimately needed it
   (i.e. was v1 ever called from the client, not just the service)?
5. A3 test: construct a hypothetical bug in `executeApprovedOrder` (e.g. resubmit-on-ACK-fail) that the
   test would STILL pass on. If you can, the test under-covers — say what it misses.
6. A4: any hidden write (an RPC, a trigger-firing select, a `.upsert` on a "read") that contradicts the
   "read_only:true" claim.
7. The class of bug the original review found — selecting a nonexistent column and swallowing the error.
   Does any Phase B query select a column that doesn't exist on the deployed schema?

Be concrete and adversarial. A defect that only bites when `AUTONOMOUS_LIVE_ENABLED=true`, or only after
the owner inserts a `kite`/`india`/`trading` row into `broker_accounts`, still counts — those states will
happen. Report it.
