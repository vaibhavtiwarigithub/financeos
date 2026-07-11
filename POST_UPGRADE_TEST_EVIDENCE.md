# POST_UPGRADE_TEST_EVIDENCE — Item 10 (17 required tests)

**Date:** 2026-07-10
**Audit:** Codex/GPT-5 deep re-audit 2026-07-10 (4.2/10). Item 10 of `POST_UPGRADE_FIX_LOG.md`.
**Spec:** the 17 required tests in `CLAUDE_CODE_POST_UPGRADE_FIX_PROMPT.md` §Required tests.

> This documents the automated test evidence only. Item 11 (Vaibhav's explicit
> approval to enable L4 / autonomous live) is a **policy gate** and is NOT
> cleared by this file. No live trading was enabled, no order placed, no money
> cap changed, no migration applied while producing this evidence.

---

## Commands & results

```
# Full unit/integration suite (default — DB tests auto-skip)
npx vitest run
  Test Files  25 passed | 1 skipped (26)
       Tests  190 passed | 6 skipped (196)
  Duration    9.77s

# Production build (test 17)
npm run build
  ✓ Compiled successfully. All routes generated. No type errors.
```

The 6 skipped tests are the opt-in live-Supabase suite (`tests/db-integration.test.ts`),
gated behind `RUN_DB_INTEGRATION=1` so `npm test` / CI never mutate the target DB.
Run explicitly with:

```
RUN_DB_INTEGRATION=1 npx vitest run tests/db-integration.test.ts
```

(requires `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`).

---

## Coverage map — 17 required tests → evidence

| # | Required test | Where | Status |
|---|---------------|-------|--------|
| 1 | Clean-DB replay: schema present | `tests/db-integration.test.ts` (schema presence: live_auto_* columns, RPC exists) | ✅ opt-in (default-skipped) |
| 2 | RPC permission matrix (anon denied, service_role allowed) | `tests/db-integration.test.ts` | ✅ opt-in (default-skipped) |
| 3 | Gateway invariants / HTTP surface | Kernel invariants covered as pure logic in `tests/autonomous-kernel.test.ts`; route-level HTTP harness **not built** | ⚠️ partial — see Honest gaps |
| 4 | Autonomous worker gate matrix | `tests/autonomous-kernel.test.ts` (13 tests: deployment flag, DB toggle, lease, direction, score, confidence, caps; ladder helpers) | ✅ |
| 5 | US + India fixture reaches submit exactly once | `tests/broker-reconcile.test.ts` (real `submitRobinhoodOrder`, single review→place) | ✅ order-path level |
| 6 | Concurrent cron → single proposal | `tests/db-integration.test.ts` (two over-cap reservations → exactly one succeeds, RPC advisory xact lock) | ✅ opt-in (default-skipped) |
| 7 | Ambiguous submit never retries (no double order) | `tests/broker-reconcile.test.ts` (missing/ambiguous order id → `needsReconcile`, no resubmit) | ✅ |
| 8 | Partial-fill no oversell | `tests/kill-and-exit.test.ts` (real `runLiveExitMonitor`; active-SELL guard + 23505 dup path; positive control proves path reaches submit) | ✅ |
| 9 | Kill blocks BUY, allows SELL | `tests/kill-and-exit.test.ts` (real `checkKillSwitches` trips `trading_enabled=false`; real sync route cancels BUY, leaves SELL) | ✅ |
| 10 | Cancel-on-kill never cancels SELL | `tests/kill-and-exit.test.ts` (real sync route `.eq("side","buy")` exercised against dataset incl. SELL; cancel/fill race reconciles) | ✅ |
| 11 | Stale India cache/quote → no size | `tests/autonomous-sizing.test.ts` (fail-closed on stale NAV, stale/absent price, qty→0) | ✅ |
| 12 | US/India caps don't cross-contaminate | `tests/autonomous-sizing.test.ts` (India skips USD per-order cap; India notional > US clamped; India Kelly not clamped) | ✅ |
| 13 | Broker persistence failure → reconcile/alert | `tests/broker-reconcile.test.ts` (persistence failure path → needsReconcile/alert, never silent success) | ✅ |
| 14 | PIT label / universe (no future data) | `tests/walk-forward.test.ts` (pre-existing: purge+embargo folds, PIT-safe labels) | ✅ |
| 15 | Frozen historical packets, no future data, report eligibility | Harness **not built** — architecture draft only: `features/historical-replay-harness/FEATURE_ARCHITECTURE.md` | ❌ deferred — see Honest gaps |
| 16 | Parabolic-reversal regression | `tests/breakdown-veto.test.ts` (8 tests: 3 veto conditions, fails-open on null diagnostics, -12% high-vol reversal capped ≤20, clean momentum >60) | ✅ |
| 17 | Full `npm test` / typecheck / build / smoke | `npx vitest run` green; `npm run build` green (above) | ✅ |

**Additional (fix-prompt §learning safety):** OOS calibration acceptance gate —
`tests/calibration-oos.test.ts` (6 tests: insufficient/degenerate/high-ECE reject,
well-calibrated accept, sanitization, null/empty fail-closed).

---

## New test files added this pass

| File | Tests | Covers |
|------|-------|--------|
| `tests/autonomous-kernel.test.ts` | 13 | test 4 + autonomy-ladder helpers |
| `tests/autonomous-sizing.test.ts` | 8 | tests 11, 12 |
| `tests/breakdown-veto.test.ts` | 8 | test 16 |
| `tests/calibration-oos.test.ts` | 6 | OOS calibration gate |
| `tests/broker-reconcile.test.ts` | 5 (+1 skip) | tests 5, 7, 13 |
| `tests/kill-and-exit.test.ts` | 8 | tests 8, 9, 10 |
| `tests/db-integration.test.ts` | 5 (opt-in) | tests 1, 2, 6 |

---

## Honest gaps (covered-vs-stubbed)

- **Test 3 (gateway HTTP surface):** the autonomous decision *logic* (every gate,
  fail-closed) is covered as pure functions in `tests/autonomous-kernel.test.ts`.
  A full route-level HTTP harness (spin the Next handler, assert status codes /
  headers / body) does **not** exist in the repo and was not built here. The
  business invariants behind the route are tested; the HTTP wire contract is not.
- **Test 5 (fixture→submit):** covered at the **order-path** level via real
  `submitRobinhoodOrder` (review→place, single call). A full end-to-end
  fixture-through-cron-to-broker harness is not built; the deterministic submit
  contract is what's asserted.
- **Test 15 (frozen historical packets):** **not implemented.** Requires a
  packet-freeze + sealed-accessor harness (~8 dev-days) that does not exist.
  Architecture drafted for approval: `features/historical-replay-harness/`.
  Test 14 (`tests/walk-forward.test.ts`) covers the PIT/no-leak property for the
  learning dataset; test 15's per-symbol eligibility replay is the deferred piece.
- **Tests 1/2/6 (DB):** written and passing but **default-skipped** to avoid
  mutating the production Supabase on every `npm test`. Run opt-in (command above).

---

## Related architecture drafts produced (awaiting owner approval — no code)

- `features/historical-replay-harness/FEATURE_ARCHITECTURE.md` — Test-15 frozen-packet eligibility harness (~8d)
- `features/pit-fundamentals/FEATURE_ARCHITECTURE.md` — point-in-time fundamentals, restatement-safe (~6d)
- `features/cross-sectional-rank/FEATURE_ARCHITECTURE.md` — cross-sectional rank gate, ships off by default (~4d to off, ~7d to promotable)

These are DRAFT proposals only. Per CLAUDE.md Architecture-First gate, none are
implemented; each awaits explicit approval before any code, migration, arch-chapter,
or system-map change.
