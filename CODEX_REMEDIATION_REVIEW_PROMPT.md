# Scoped Adversarial Review — 2026-07-10 Remediation & Money-Path Unification

You have READ access to this repository. **Ground every claim in `file:line`; verify against code,
not comments or docs.** This is a focused re-audit of the code changed in the 2026-07-10 remediation
work (commits after the full-system audit `CODEX_FULL_SYSTEM_AUDIT_RESULT.md`). Your prior full audit
found real bugs (a zero-signal dead-end, calibration leakage, RLS holes) — apply the same adversarial
rigor to the NEW code, which is mostly on the LIVE-MONEY path. Assume it has bugs. Find them.

Write your report to `CODEX_REMEDIATION_REVIEW_RESULT.md` (repo root, overwrite). Structure: (1) exec
verdict; (2) ranked findings table [rank | severity | area | finding | file:line | concrete fix];
(3) money-path integrity gate-by-gate; (4) what you could not verify. Money/security findings outrank
everything. If nothing is wrong in an area, say so in one line.

## Scope — review these files/changes (and anything they touch)

**Unified execution gateway (highest scrutiny):**
- `lib/trading/execute-order.ts` — NEW shared `executeApprovedOrder(svc, input, actor)`. Verify it
  reproduces the manual gateway's invariants EXACTLY (owner path unchanged), the `actor` split is
  safe (autonomous_worker cannot override risk gates, cannot execute a non-`autonomous_live` proposal,
  bypasses the owner-approval status check ONLY for autonomous), the v1→v2 RPC switch is behavior-
  equivalent for owner, and the dailyNotionalCap/maxDailyTrades overrides are applied correctly.
- `app/api/broker/orders/route.ts` — now delegates. Confirm identical HTTP status/error mapping,
  needs_reconcile (202), and that owner+CSRF gating is intact.
- `lib/trading/autonomous-live.ts` — heavily changed: signal query (real `confidence` col + fatal
  error), fresh `checkKillSwitches`, fail-closed lease/flags, per-market currency-correct NAV
  (US=RH USD snapshot, India=Kite INR margins+holdings), net open-position count, idempotent claim
  (migration 145 + 23505 skip), effective daily-cap fail-closed, and delegation to executeApprovedOrder.
  Hunt: double budget reservation, currency/NAV mismatch, a path that still submits without all gates,
  broker_order_events written with a possibly-null order id, results/status mislabeling.

**Broker adapter (serverless submit):**
- `lib/brokers/robinhood/rest-client.ts` — rewritten: side/account, `rhGetOrder`, `rhCancelOrder`,
  ambiguous→needs_reconcile. Verify account pinning, qty validation, no injection, correct status
  mapping, and that a network failure after POST is treated as ambiguous (not a clean reject).
- `lib/brokers/adapters/robinhood.ts` — NEW REST adapter. Verify allowlist account resolution,
  robinhood_mcp_enabled kill switch, needsReconcile propagation, live-only env.
- `lib/brokers/registry.ts` — added `robinhood`. `execute-order.ts` gates both robinhood ids.

**Market calendar / live status:**
- `lib/trading/market-calendar.ts` — session+holiday+AV MARKET_STATUS gate. Verify fail-closed on
  confirmed closed, correct region matching (US + India), the unreachable→fallback logic, timezone/DST
  correctness, and the 5-min cache can't wedge a stale "open".

**Order reconcile / cancel-on-kill:**
- `app/api/broker/orders/sync/route.ts` — added cancel-on-kill. Verify it only cancels (never places),
  scopes to the tripped market, and can't loop/cancel unrelated orders.

**Scoring / learning / calibration:**
- `lib/validation/calibration.ts` — fold-local fitting (leakage fix). Confirm no residual train/test leak.
- `lib/scoring/weighted-score.ts` — `abstain` flag. `lib/data/scores.ts` + `technicals.ts` — sector-P/E,
  analyst-target, continuous RSI, volume scoring. `lib/research-agent.ts` — weighted evidence_confidence,
  positive score_source allowlist. `app/api/agents/paper-trade` + `trader` allowlist.
- `app/api/agents/learner/route.ts` — challenger baseline from market champion + simplex renormalize.

**Security:**
- `lib/vault-pin.ts` — scrypt hash + legacy-plaintext verify. Confirm constant-time, no downgrade hole.
- Route auth added (smart-money, theme-scout GET, mentor evaluate/journal/scores, import-csv).
- Migrations `143` (live-auto DDL/RPC restore, idempotent), `144` (RLS owner-scoping), `145` (unique
  autonomous-claim index). Verify idempotency, correct RLS, and no over-broad grants.

## Specific things to try to break
1. Can the autonomous path reserve budget TWICE (its own + the service's) or submit without a gate?
2. Currency: can a per-order/daily USD cap be checked against an INR notional (or vice-versa) anywhere?
3. Does the owner manual path behave EXACTLY as before R13 (same errors, statuses, gates)?
4. `isMarketOpenLive` unreachable-AV fallback — can it ever return open when truly closed in a way that
   causes real harm (vs the broker-rejection backstop)?
5. vault-pin: can a hashed PIN be bypassed via the legacy plaintext branch?
6. Migration 143 on a clean DB vs prod — does it reproduce the exact RPC/table/trigger?
7. Any place still selecting a nonexistent column and swallowing the error (the original R1 class of bug)?

Be concrete and adversarial. A defect that only bites when `AUTONOMOUS_LIVE_ENABLED=true` still counts —
that flag will be flipped. Report it.
