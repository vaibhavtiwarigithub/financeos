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
| F6: Kill switches read paper_portfolio / paper_performance / paper_trades | Codex | CONFIRMED | kill-switches.ts:35-39 queries paper tables only | P0 BLOCKING: AUTONOMOUS_LIVE_ENABLED=true in Vercel. Kill switches measure wrong account. Must fix before enabling live_auto_enabled or raising autonomy_level to L4. |
| F7: Live-exit-monitor no atomic claim — duplicate SELLs on concurrent run | Codex | CONFIRMED | live-exit-monitor.ts no 23505 check on SELL insert | Fixed: check pending_review/queued_auto proposal + active broker_orders SELL before insert |
| F8: Cancel-on-kill cancels ALL orders including protective SELLs | Codex | CONFIRMED | sync/route.ts:119 no `.eq("side","buy")` filter | Fixed: added `.eq("side","buy")` to resting orders query |

---

## Deferred (Phase 2+)

| Item | Why deferred |
|------|-------------|
| Kill switches live data (F6) | RECLASSIFIED P0 — AUTONOMOUS_LIVE_ENABLED=true in Vercel. Requires live_account_snapshots historical series + PnL tracking from broker_orders. Paper kill switch is measuring wrong account. Must fix before live_auto_enabled=true or autonomy_level=L4. |
| Robinhood unofficial REST (Finding 9 from original audit) | Read-only risk page use; does not touch order placement. Official RH Trading MCP at agent.robinhood.com/mcp/trading cannot be used from Vercel serverless crons. Remains blocked until official serverless MCP client is available. |
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

---

## Required Before Enabling L4 / Autonomous Live

1. ✅ RPC permissions secured
2. ✅ Confidence gate working (conviction/100)
3. ✅ L4 enforced in gateway
4. ✅ India currency isolated
5. ✅ Duplicate SELL protected
6. ✅ Cancel-on-kill preserves SELLs
7. ❌ Kill switches must read live broker data (not paper) — BLOCKING
8. ❌ Live exit atomicity: full `(account,market,symbol,position_epoch)` claim
9. ❌ Official Robinhood Trading MCP for order placement (not unofficial REST)
10. ❌ 17 integration tests from fix prompt must pass
11. ❌ Vaibhav's explicit approval required
