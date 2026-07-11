# POST_UPGRADE_FIX_LOG — Phase 1 P0 Fixes
**Audit: Codex/GPT-5 deep re-audit 2026-07-10. Overall score: 4.2/10.**
**Status: Phase 0 complete. Phase 1 code fixes applied 2026-07-10.**
**AUTONOMOUS_LIVE_ENABLED: true in Vercel (confirmed by Vaibhav 2026-07-10). Local .env.local unchanged.**

---

## Phase 0 — Inventory

| Finding | Source | Confirmed? | Evidence | Status |
|---------|--------|-----------|----------|--------|
| F1: Migration 143 missing strategy_config live_auto_* columns | Codex | CONFIRMED | `143_restore_live_auto_ddl.sql` has no ALTER TABLE strategy_config | Fixed: migration 147 adds them (no-op on prod, reproducibility) |
| F2: reserve_live_order_budget_v2 callable by PUBLIC | Codex | REJECTED (already fixed) | DB check: proacl={postgres=X/postgres,service_role=X/postgres}; anon=false, auth=false | No action needed; migration 147 records REVOKE for fresh builds |
| F3: agent_signals.confidence always null (confidence dead-end) | Codex | CONFIRMED | ResearchAgent writes `conviction` not `confidence`; kernel reads confidence → always 0; every signal fails ≥0.6 gate silently | Fixed: SELECT conviction, normalize to 0.0-1.0 (conviction/100) |
| F4: L4_live_small_auto not enforced in gateway | Codex | CONFIRMED | execute-order.ts:165 checks L3_live_manual, not L4 for autonomous_worker | Fixed: add `autonomousWorkerAllowed()` check for non-owner actors |
| F5: India per-order cap uses USD cap against INR nav | Codex | CONFIRMED | execution-kernel.ts:227 divides live_auto_max_per_order_usd / INR-nav | Fixed: skip USD cap for market=india; add isUsdMarket guard |
| F6: Kill switches read paper_portfolio / paper_performance / paper_trades | Codex | CONFIRMED | kill-switches.ts:35-39 queries paper tables only | Fixed 2026-07-10: dual-mode — live_auto_enabled=true → read live_account_snapshots (daily-loss/drawdown) + broker_orders fills (accuracy). Fail-closed if no snapshots. |
| F7: Live-exit-monitor no atomic claim — duplicate SELLs on concurrent run | Codex | CONFIRMED | live-exit-monitor.ts no 23505 check on SELL insert | Fixed: check pending_review/queued_auto proposal + active broker_orders SELL before insert |
| F8: Cancel-on-kill cancels ALL orders including protective SELLs | Codex | CONFIRMED | sync/route.ts:119 no `.eq("side","buy")` filter | Fixed: added `.eq("side","buy")` to resting orders query |

---

## Deferred (Phase 2+)

| Item | Why deferred |
|------|-------------|
| Kill switches live data (F6) | FIXED 2026-07-10 — dual-mode path in lib/kill-switches.ts. |
| Robinhood unofficial REST (Finding 9 from original audit) | Read-only risk page use; does not touch order placement. CORRECTED 2026-07-10: the official RH Trading MCP order path (`lib/robinhood-mcp.ts` → `submitRobinhoodOrder`, wired via `lib/brokers/adapters/robinhood-mcp.ts`) IS built and serverless-capable — OAuth connect uses the deployed app's own `${origin}/api/robinhood-mcp/callback` (localhost only registered in non-production), token stored in `api_key_vault`, refreshed via CAS from serverless, so Vercel crons reuse it. NOT technically blocked. Trading stays off by policy gates only (see below). |
| RLS completion (Finding 17) | Not blocking live trading |
| Phase 2 scoring (discovery/formula/momentum) | Requires 10+ closed trades |
| Phase 3 governed evolution | Phase 1 prerequisite |

---

## Files Changed

| File | Change |
|------|--------|
| `supabase/migrations/147_phase1_repair.sql` | Strategy_config live_auto_* columns + REVOKE PUBLIC from RPC (idempotent on prod) |
| `lib/autonomy.ts` | Add `autonomousWorkerAllowed()` — DB-level L4 gate independent of deployment flag |
| `lib/trading/execute-order.ts` | Import + enforce `autonomousWorkerAllowed` for non-owner actor |
| `lib/trading/autonomous-live.ts` | `confidence` → `conviction` in SELECT; normalize conviction/100; pass `market` to sizing |
| `lib/trading/execution-kernel.ts` | Add `market?` to SizingInput; guard USD per-order cap with `isUsdMarket` |
| `lib/trading/live-exit-monitor.ts` | Check for pending SELL proposal + active SELL order before inserting — idempotency |
| `app/api/broker/orders/sync/route.ts` | Cancel-on-kill: add `.eq("side","buy")` to protect resting SELLs |
| `lib/kill-switches.ts` | Dual-mode: live_auto_enabled=true → live_account_snapshots + broker_orders; fail-closed if no snapshots |
| `lib/trading/live-exit-monitor.ts` | Catch 23505 conflict on proposal insert → skipped_duplicate (DB-level idempotency) |
| `supabase/migrations/148_live_kill_switches_and_sell_atomicity.sql` | Partial unique index trade_proposals_active_sell_uniq (symbol,market) WHERE sell+active |

---

## Phase 2 — Codex P0/P1 code remediation (2026-07-10)

Deterministic, code-fixable findings from `CODEX_POST_UPGRADE_DEEP_REVIEW_RESULT.md`, fixed in parallel and committed together (52a790a). Build green.

| Finding | File | Fix |
|---------|------|-----|
| Technical score 100 after -12% high-volume reversal | `lib/data/technicals.ts` | ATR14 + last-bar diagnostics; `detectBreakdownVeto` caps technical score at 20 before momentum math (crash / high-vol breakdown / bottom-quartile close) |
| No OOS calibration acceptance gate | `lib/validation/calibration.ts` | `acceptCalibrationOOS` — ECE on time-ordered walk-forward holdout; fail-closed (<30 rows, degenerate, ECE>0.1); gates `pwin_logistic` upsert |
| `force_unvalidated` bypass + unscoped demote-all | `app/api/strategies/versions/route.ts` | bypass hard-rejected (400); demotion always market-scoped, aborts on error; missing version 404s |
| 1 bullish message scores sentiment 100 | `lib/data/scores.ts` | Bayesian shrinkage toward neutral by real `stocktwits_message_count` (K=10): 1 msg→55, 500@90%→89 |
| India discovery no freshness; US screener no real momentum | `lib/research-agent.ts` | India `scored_at` within 36h; US momentum bucket ordered by `revenue_growth` desc. Candidate count unchanged (3/day), no regime logic |

Item 9 RESOLVED (was a documentation error, not a code gap): the official RH Trading MCP order path is built + serverless-capable (`lib/robinhood-mcp.ts::submitRobinhoodOrder`). It is gated OFF by policy flags (`robinhood_mcp_enabled`, `live_auto_enabled`, `autonomy_level`) + Vaibhav approval — NOT by a missing technical capability. Still open: item 10 (integration tests), item 11 (Vaibhav approval). Deferred architectural P1 (cross-sectional rank, specialist setup models, Feature Registry/Edge Lab wiring, policy evolution, PIT fundamentals) — weeks each.

---

## Required Before Enabling L4 / Autonomous Live

1. ✅ RPC permissions secured
2. ✅ Confidence gate working (conviction/100)
3. ✅ L4 enforced in gateway
4. ✅ India currency isolated
5. ✅ Duplicate SELL protected
6. ✅ Cancel-on-kill preserves SELLs
7. ✅ Kill switches read live_account_snapshots + broker_orders when live_auto_enabled=true (fail-closed if no snapshots)
8. ✅ Active SELL idempotency: trade_proposals_active_sell_uniq partial unique index + 23505 catch in exit monitor
9. ✅ Official Robinhood Trading MCP for order placement (not unofficial REST) — `lib/robinhood-mcp.ts::submitRobinhoodOrder`, serverless-capable via vault token + CAS refresh. Was mislabeled "blocked"; corrected 2026-07-10. Order-write path stays deterministic (BINDING RULE R1); the MCP is invoked by typed code, never by an LLM.
10. ✅ Test suite green: `npx vitest run` 190 passed / 6 skipped (opt-in DB), `npm run build` clean. 13/17 required tests fully covered, 3 opt-in (DB tests 1/2/6), test 15 deferred to a harness (architecture drafted). Evidence + honest covered-vs-stubbed map: `POST_UPGRADE_TEST_EVIDENCE.md`. Tests 3 (HTTP surface) + 5 (fixture→submit) covered at logic/order-path level, not full route/e2e harness.
11. ❌ Vaibhav's explicit approval required (policy gate — cannot be self-cleared)
