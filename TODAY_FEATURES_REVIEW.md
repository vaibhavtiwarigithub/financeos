# Today's Features — Review Request (2026-07-08)

**For:** ChatGPT senior review. **Reviewed/updated by ChatGPT, 2026-07-08.**
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

## 5. Reviewer findings (ChatGPT)

[CRITICAL] → `lib/robinhood-mcp.ts:619-626`, `app/api/broker/orders/route.ts:234-238` → `robinhoodHeldQty(symbol, account)` accepts an account argument but does not pass it into `get_equity_positions`; it calls the MCP with `{}`. If Robinhood returns the default/read-only account first, or returns positions without account metadata, the fallback position pool can satisfy the live SELL held-position gate with shares that are not in the agentic trading account. That can submit a SELL against the wrong account context or attempt a sell the agentic account cannot cover. → Pass `{ account_number: account }` to `get_equity_positions` whenever `account` is provided; remove the unscoped fallback for account-scoped SELL checks; require each parsed holding to match the requested account or come from an account-scoped MCP response. → Fail closed: live SELL returns 403 unless holdings are verified for the exact trading account; parse/call failure returns 503/403 before broker submission.

[HIGH] → `lib/robinhood-mcp.ts:598-601`, `app/api/live-account/refresh-snapshot/route.ts:23-25`, `app/api/live-account/refresh-snapshot/route.ts:53-61` → `queryRobinhoodAccount(account)` can fall back to an `agentic_allowed` or first parsed account when the explicit requested account is missing, and the refresh route then writes the resulting NAV/positions under the requested `tradingAccount`. This can store wrong-account NAV/positions and feed the G3 portfolio gate with the wrong live book. The position metadata fallback also matches only `account_number`, while the portfolio path uses `rhs_account_number`. → If an explicit account is requested and cannot be resolved exactly, return an error instead of falling back; verify the returned account number equals `tradingAccount` before upsert; match both `account_number` and `rhs_account_number` when normalizing Robinhood data. → Fail closed: snapshot refresh returns 500/503 and does not overwrite `live_account_snapshots`; G3 then requires a fresh valid snapshot or owner override.

[HIGH] → `app/api/live-account/refresh-snapshot/route.ts:83-97`, `lib/risk/live-portfolio-gate.ts:55-61` → The anti-clobber guard only blocks when both `equity == null` and `posCount === 0`. If portfolio/NAV parses but positions fail, are rate-limited, or unwrap to empty, the route can overwrite a previously good non-empty `positions_json` with `null`/empty while keeping a fresh `captured_at`. G3 then sees an empty book and can approve concentration/name exposure that should have been blocked. → Treat positions freshness independently from NAV freshness: preserve prior non-empty positions unless Robinhood explicitly confirms the account has zero positions; or fail refresh when positions cannot be parsed for an account known to have prior positions. Add `positions_captured_at` if needed. → Fail closed for G3: unverified/missing positions on a live account require `acceptPortfolioRisk:true`; never silently treat unknown positions as empty.

[HIGH] → `app/api/kite/order/route.ts:120-143`, `app/dashboard/india/page.tsx:139-156`, migration `105_daily_live_budget.sql` → Direct Kite live orders have no durable idempotency key. Because `proposal_id` is `null`, the duplicate-submit unique index does not dedupe double-clicks/retries; the budget RPC serializes the request but cannot distinguish accidental resubmission from a second intentional order. → Add a required `client_order_key` generated by the UI per confirmation; persist it on `broker_orders`; add a partial unique index on `(broker, broker_env, client_order_key)` for active/non-terminal statuses; have the RPC insert/check this key atomically before broker submission. → Fail closed: duplicate retry returns 409 before broker submit; ambiguous prior submit remains `needs_reconcile` and is not resubmitted automatically.

[HIGH] → `app/api/kite/order/route.ts:17-27`, `app/api/kite/order/route.ts:120-143` → India live BUY can bypass the G1 signal-quality/proposal gate entirely. A request with `confirm:true` can place an arbitrary BUY without `signal_id`, `trade_proposals`, `v_decision_quality`, or a durable manual override trail. This is human-clicked, but it is not governed the same way as the US gateway path. → Route agent-derived India BUYs through `trade_proposals` and the unified gateway, or require `signal_id` plus `v_decision_quality` validation in the Kite route. For pure manual buys, require `manualOverride:true` and a reason persisted to `decision_journal`/order metadata. SELL exits remain exempt from G1. → Fail closed: India BUY without a linked quality record or persisted manual override returns 409/403 before budget reservation and broker submit.

[HIGH] → `lib/risk/live-portfolio-gate.ts:55-67` → G3 values existing live positions as `qty * average_buy_price`, defaulting missing cost to `0`. If Robinhood provides `market_value`, `equity`, `current_price`, or `last_price` but no average cost, exposure is understated; if all price fields are missing, non-zero holdings can become zero-value positions. That weakens name/gross/sector concentration controls. → Value holdings using the best available current market value first (`market_value`, `equity`, `value`), then `qty * current_price/last_price/price`, and only then `qty * average_buy_price`; if a non-zero holding cannot be valued, return an indeterminate G3 result. → Fail closed/controlled: live BUY returns 409 requiring `acceptPortfolioRisk:true` when existing holdings cannot be valued; never count non-zero holdings as zero exposure.

[MED] → `lib/risk/live-portfolio-gate.ts:49-50`, `app/api/broker/orders/route.ts:213-218` → G3 currently fails open on stale/absent NAV. That avoids false-blocking legitimate trades, but it also means a stale or failed live snapshot skips portfolio construction entirely. For a live-money BUY gate, unknown portfolio risk should not silently pass. → Change stale/absent NAV from `ok:true skipped` to `requires_override` and return 409 unless the owner explicitly sends `acceptPortfolioRisk:true`; keep SELL exempt. → Fail controlled: live BUY needs either a fresh snapshot or an explicit owner override; stale data never silently approves risk.

[MED] → `app/api/broker/orders/route.ts:144-153`, `app/api/broker/orders/route.ts:213-218` → `acceptLowQuality` and `acceptPortfolioRisk` are raw request-body booleans. They are owner-gated, but they do not require a durable reason, timestamp, or reapproval record before bypassing missing/low data quality or unknown portfolio risk. That makes later audit and learning integrity weak. → Persist override decisions before submit, including proposal/order id, override type, reason, accepted_by, and accepted_at. Reject override flags without a non-empty reason and durable write. → Fail closed: override attempt that cannot be recorded returns 409/500 before budget reservation and broker submit; no autonomous override path.

[MED] → migration `105_daily_live_budget.sql:61-68`, `app/api/kite/order/route.ts:148-156` → The budget RPC excludes terminal statuses `error`, `rejected`, and `canceled`, but Kite writes failed broker submissions as `failed`. A clearly failed Kite order can still consume daily count/notional and block legitimate later trades. → Standardize Kite failed broker submissions to `error`, or include `failed`/`expired` in the RPC's terminal-status exclusion list after confirming they are final and not ambiguous. Keep `submitted`, `partial`, `filled`, and `needs_reconcile` counted. → Fail behavior: confirmed final failures do not consume daily budget; ambiguous sent/unknown outcomes continue to consume budget until reconciled.

[MED] → migration `104_v_decision_quality.sql:41-46` → `v_decision_quality` directly casts JSON text values to numeric/boolean. Malformed `base_weights`, `availability_mask`, or `technical.dataPoints` can make the view query throw, even though the design says malformed data should produce `data_confidence = NULL` and `quality_status = 'unknown'`. Live code mostly blocks on query failure unless overridden, but the failure mode is operationally noisy and can break health triage. → Use guarded casts with `jsonb_typeof`/regex checks, or helper SQL functions that return NULL on invalid numeric/boolean input. → Fail behavior: malformed quality inputs return `quality_status='unknown'`; live BUY blocks unless a durable `acceptLowQuality` override is recorded.

[MED] → migration `105_daily_live_budget.sql:67`, `app/api/agents/paper-trade/route.ts:373-376` → Daily live and paper budget windows use UTC `current_date`/`toISOString().split('T')[0]`, not market-local trading days. US Central/ET and India IST orders near UTC boundaries can be counted into the wrong "day", causing false blocks or under-counting. → Compute the budget date in the market timezone (`America/New_York` for US, `Asia/Kolkata` for India) inside the RPC and paper flow, or pass a validated market-day key from server code. → Fail closed for live budget if market day cannot be computed; do not reserve against an ambiguous day.

[MED] → `app/api/settings/risk-profile/route.ts:177-185` → Money-limit settings writes can silently retry after stripping fields listed in `OPTIONAL_COLS`. Since migrations 102-110 are applied, `max_order_notional_usd/_inr`, `max_daily_notional_usd/_inr`, and paper cap columns should no longer be optional. A failed update could return success while leaving old limits active. → Remove money-limit columns from the optional-strip retry path; only genuinely backward-compatible non-money fields may be optional. If any money-limit field is present and update fails, return a visible error. → Fail closed/visible: settings save fails and old limits remain; the UI does not imply a cap changed when it did not.

[LOW] → `app/api/kite/order/route.ts:74-83` → The per-order notional cap is applied to SELL as well as BUY. SELL reduces long exposure and is already held-position gated, so this can block legitimate de-risking exits for larger positions. → Apply the per-order cap only to BUY, or allow SELL after exact holdings verification. Keep SELL quantity limited to held shares. → Fail behavior: BUY remains fail-closed on cap breach; SELL exits are not blocked by notional cap but still fail if holdings cannot be verified.

[LOW] → Currency separation review → No direct USD-vs-INR arithmetic mix was found in the shipped cap paths: US gateway selects USD caps, Kite selects INR caps, daily budget receives market-specific notional/currency, and paper caps branch by `market`. Remaining risk is wrong-account/wrong-snapshot input data and market-day scoping, not direct currency comparison. → Keep per-market columns and do not reintroduce legacy `max_order_notional` for INR paths. → Fail behavior remains per-market fail-closed when a required cap is missing.

[LOW] → `app/api/agents/health-triage/route.ts:20-109`, `components/dashboard/SystemHealthCard.tsx:62-68` → Clean for live-money safety: route is owner/cron-gated, read-only with no tools, writes only `health_triage`/`agent_runs`, and the prompt forbids autonomous money/config/order/code changes. → Optional polish only: if the UI should surface triage provider failure, return a non-200 status instead of only writing `agent_runs.error`. → No broker/order fail behavior required because this path cannot submit or mutate trading controls.

---

## 6. Resolution status (Claude, 2026-07-08) — ALL FIXED + shipped

Every finding above was verified against the real code and fixed (commit "Fix ChatGPT
review findings on today's features (14 issues)"), migrations 111–113 applied+verified,
golden cases + build green:

- **CRITICAL** robinhoodHeldQty account-scoping → pass account_number to get_equity_positions.
- **HIGH** queryRobinhoodAccount no-fallback on explicit-account miss; refresh only overwrites
  on a complete fetch; G3 values holdings by best-available price (indeterminate→block);
  India BUY G1-parity (signal quality or audited manualOverride); Kite idempotency key
  (client_order_key + partial unique index + UI-generated).
- **MED** G3 fail-controlled on stale NAV (409+override); override reasons audited to
  decision_journal; budget RPC uses market-local day + excludes failed/expired (mig 111);
  money-limit saves never silently retry-strip; v_decision_quality guarded casts (mig 112).
- **LOW** per-order cap BUY-only (never blocks a SELL exit).

The two "clean" findings (currency separation, health-triage) needed no change. The optional
health-triage polish (surface provider failure as non-200) is deferred (advisory only).
