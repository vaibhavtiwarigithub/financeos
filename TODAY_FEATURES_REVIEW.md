# Today's Features — Review Request (2026-07-08)

**For:** ChatGPT senior review. **Fill in §Findings at the bottom.**
This scopes everything shipped on 2026-07-08 for a live-money algorithmic trading app
(Next.js 15 + Supabase/Postgres, TypeScript). Review for logic, wiring, race conditions,
fail-open/closed mistakes, schema-coupling, and safety-rule violations. All migrations
below were **already applied to prod + verified** before their code shipped.

---

## 1. What shipped today (by area)

### A. Security (earlier)
- Migration 102: closed 2 CRITICAL RLS gaps — `app_settings` (vault PIN) + `live_account_snapshots`
  (live financials) were readable via the public anon key. Revoked anon/authenticated, dropped
  permissive policies.
- `app/api/admin/vault/route.ts`: timing-safe PIN check (SHA-256 + timingSafeEqual).
- `lib/auth/require-owner.ts`: gate on email AND `email_confirmed_at`.
- `lib/request-guards.ts`: host check before cron bypass; non-GET rejects null Origin.
- Robinhood-MCP order path hardening (`lib/robinhood-mcp.ts`): `sent` flag (ambiguous vs
  rejected → needsReconcile), review-echo side/account/type verify, order-id parse, token refresh CAS.

### B. Per-market notional caps (Part A) — migration 103
- `strategy_config.max_order_notional_usd` / `_inr` (Settings-editable; legacy `max_order_notional`
  kept one release as USD read-through).
- `app/api/broker/orders/route.ts` (US Gateway) + `app/api/kite/order/route.ts` (India): pick cap by
  market; India fail-closed if INR cap null (no Kite equity fallback); fresh-quote required.

### C. Data-quality view (learning-integrity Phase 1, measure-only) — migration 104
- `v_decision_quality`: deterministic view over append-only `decision_observations`.
  `data_confidence = Σ base_weights[real dims] / Σ base_weights[applicable dims]`.
  applicable: india={fundamental,technical,macro}; ETF={technical,sentiment,macro};
  US non-ETF={fundamental,technical,sentiment,macro,insider}. real = availability_mask[d]=true
  AND not degraded (macro regime='unknown'; technical dataPoints<15; fundamental note~'no fundamental data').
  NULL/malformed weights → data_confidence NULL, quality_status='unknown' (fail-open). Golden-tested
  (GLD/SGOV/IBIT → 0.2–0.33 low; India fund+tech → 0.79). Caught + fixed a NULL-coalesce bug that
  wrongly dropped a real dim. Measure-only: no tagging/exclusion yet.

### D. Daily live budget (G4/G5/G6) — migration 105
- `strategy_config.max_daily_notional_usd/_inr` + `max_daily_trades` (Settings-editable).
- `broker_orders.estimated_notional` + `currency`.
- `reserve_live_order_budget()` RPC (SECURITY DEFINER, service_role only): under a
  `pg_advisory_xact_lock(current_date||':'||market)`, enforces daily BUY count + cumulative notional
  and inserts the pending row atomically (closes the read-then-insert TOCTOU). LIVE BUY only — paper
  + SELL exempt. Gateway + Kite route both call it (daily_trade_limit→429, daily_notional_limit→403,
  dup 23505→409).

### E. G7 / G9 / G11 / G8
- G7 (`broker/orders`): equity-fallback cap requires snapshot ≤30 min, else fail-closed.
- G9 (`kite/order`): now gates on trading_enabled + trading_enabled_india + `checkKillSwitches('india')`
  (was bypassing kill switch entirely).
- G11 (`broker/orders`): live SELL fallback scoped to `acct.account` + ≤30 min freshness (was unfiltered).
- G8 (migration 106 + `lib/kill-switches.ts`): on kill-switch trip, flag resting live orders
  `risk_status='kill_switch_review_required'` + CRITICAL alert. No auto-cancel.

### F. Order-limit defaults + NAV-scaled paper caps + Reset — migration 107
- Live defaults: per-trade US $500 / IN ₹20000; daily US $5000 / IN ₹30000.
- New paper cap columns `max_order_notional_usd/inr_paper` + `max_daily_notional_usd/inr_paper`
  (defaults US $2500/$5000, IN ₹250000/₹500000 — ~25%/50% of paper NAV).
- `app/api/agents/paper-trade/route.ts`: per-trade cap folded into `maxSpend` (qty auto-bounds);
  daily cumulative paper BUY notional capped per market (skips over cap, never blocks a sell).
- Settings UI (`app/dashboard/settings/page.tsx`): all fields + "Reset to defaults" button.

### G. G1 signal-quality live gate — migration 108
- `trade_proposals.signal_id` bigint→uuid (was a latent bug: trader wrote a uuid into a bigint column).
- `broker/orders`: live BUY refused when the linked decision's `data_confidence` < 0.5 / `quality_status`
  != 'ok' / no linked record. Owner override `acceptLowQuality:true`. SELL exempt.

### H. Self-healing Part B — migrations 109/110
- `health_triage` table (deny-by-default RLS) + `agent_config` seed 'health-triage' (deepseek-v4-flash,
  Settings-selectable).
- `app/api/agents/health-triage/route.ts`: cron/owner-gated, READ-ONLY (no tools, no write path to
  money/config/order/weight/code). Reads open alerts + agent_runs errors + v_decision_quality taint rate
  + provider budgets → cheap-model SRE triage → stores to health_triage + logs agent_runs. 6h cron.
- `components/dashboard/SystemHealthCard.tsx`: "AI Triage" section + Run button.

### I. Live NAV capture + G3 live portfolio gate
- `lib/robinhood-mcp.ts` `queryRobinhoodAccount(account?)`: Robinhood keeps portfolio value in
  `get_portfolio` (account-scoped, needs rhs_account_number), NOT `get_accounts`; `get_equity_positions`
  is ALSO account-scoped. Now resolves the agentic account and calls both with account_number.
- `app/api/live-account/refresh-snapshot/route.ts`: reads `data.total_value` as NAV (not RH's
  holdings-only `equity_value`), `data.buying_power.buying_power`; unwraps `data.positions`; anti-clobber
  guard (empty fetch won't overwrite a good snapshot). Verified live: NAV 998.79 + IBIT x1.
- `lib/risk/live-portfolio-gate.ts` + `broker/orders`: G3 — US live BUY runs `constructPortfolio`
  (`lib/portfolio/constructor.ts`) vs the live book (position value = qty×avg_cost / NAV); refuses a BUY
  that would breach name/gross/(best-effort sector/vol) limits (409; `acceptPortfolioRisk:true` overrides).
  Fail-OPEN on stale/absent NAV. US only (India has no live NAV source).

## 2. Known schema facts (source of truth)
- `decision_observations` / `broker_orders` (order_events) / `paper_order_events` are append-only (triggers block delete/update).
- `agent_signals.id`, `decision_observations.signal_id`, `paper_trades.signal_id`, now `trade_proposals.signal_id` = uuid.
- `broker_orders` links to a proposal via `proposal_id` (no signal_id column).
- `strategy_config` is a single-row table. `live_account_snapshots.equity` now populated from get_portfolio.

## 3. Project safety rules (must not be violated)
- New positions long-only; SELL only on held positions.
- Live orders require an owner human click; never cron-callable (except the internal cron secret on advisory routes).
- No LLM autonomously changes money limits, config, weights, orders, or code.
- Schema-coupled code ships only after its migration is applied.
- Max 3 screener candidates/day; no explicit bull/bear regime switching.
- Additive migrations only near append-only ledgers; never delete them.

## 4. Review focus (what to hunt)
- Currency mixing (USD vs INR) anywhere a cap/notional/NAV is compared.
- Fail-open vs fail-closed correctness on every live-money branch.
- The `reserve_live_order_budget` RPC: any path that reaches broker submit WITHOUT going through it;
  paper vs live gating; SELL exemption correctness.
- The G1/G3 gates: do they block legit trades? do overrides bypass anything they shouldn't?
- `queryRobinhoodAccount` account resolution: wrong-account NAV/positions risk.
- `v_decision_quality`: any way it mis-scores (division, null handling, applicable-dim set per asset class).
- Paper-cap enforcement: does it distort sizing incorrectly or block sells?
- Anything shipped whose migration might NOT be applied (should be none — but verify the code assumes it).

---

## 5. Reviewer findings (ChatGPT) — FILL THIS IN
> For each issue: [severity CRITICAL/HIGH/MED/LOW] → file:line (or migration) → the problem →
> the concrete fix → fail-behavior. Rank money-loss risk first. If a section is clean, say so.
> Do not propose anything that violates §3. Update the author line to note your review.

_(empty — awaiting review)_
