# Risk Management Audit — Kairos

**Author:** Claude (Opus 4.8), reviewed/updated by ChatGPT, 2026-07-08. Verified against live code + prod DB.
**Purpose:** Assess actual (code-enforced, not config-column) risk controls, grade each
layer, and enumerate gaps for review + fix.
**Method:** Grep/read of enforcement paths + prod `strategy_config` values. A config
column existing != a control being enforced — only code that *reads and acts on* a limit
counts here.

---

## 1. Scorecard

Two grade columns: **ChatGPT (pre-fix)** = the assessment ChatGPT recorded on the code as
it was; **Post-fix (Claude 2026-07-08)** = after this session's G2/G4–G12 fixes shipped +
verified. Only controls whose fix actually shipped are upgraded. See §7 for the fix list.

| Layer | ChatGPT (pre-fix) | Post-fix | What changed |
|---|---|---|---|
| Circuit breakers (kill switches) | B | **A−** | G8: kill switch now flags resting live orders for review; G9: Kite path now calls `checkKillSwitches`. Held at A− because kill-switch math still uses paper NAV/outcomes, not confirmed live broker P&L. |
| Operational safety | B | **A−** | G4/G5/G6: daily count + cumulative notional now enforced atomically via `reserve_live_order_budget()` (advisory-locked, closes the read-then-insert race); G9: Kite no longer bypasses kill-switch/trading_enabled. |
| Position sizing | B paper / C live | **B paper / B− live** | Live sizing now bounded by per-order + daily notional caps (per market, fail-closed). Still B− (not B) because the Gateway doesn't recompute Kelly/`max_position_pct` from live equity. |
| Exit management | B paper / D live | **B paper / D live** | Unchanged — no live broker stop/target/cancel-replace control added. |
| Per-order live controls (US) | B | **B+** | G7: equity-fallback cap requires a fresh (≤30 min) snapshot; G2: per-market USD cap (`max_order_notional_usd`), Settings-editable. |
| Per-order live controls (India) | D | **B** | G2/G10: INR notional cap + fresh-quote check (fail-closed); G9: kill-switch + trading_enabled gate. |
| Portfolio construction limits | B paper / F live | **B paper / F live** | Unchanged — G3 (port paper limits to live Gateway) not started. |
| Data-integrity (garbage-in) | C (in progress) | **B− (live BUY gated)** | G1: live BUY now refused when the linked decision's `data_confidence` < 0.5 / `quality_status != ok` (migration 108). Learner-side auto-exclude still deferred on US calibration → not yet A. |

**Overall: paper B+, live C → live B−.** India now has a notional + kill-switch gate, daily
count/notional is atomic, and the equity fallback is freshness-bounded. Live is held below
B by three unshipped items: **G3** (portfolio-construction limits are still paper-only),
no **live stop/target** control (exit management D live), and **G1** signal-quality not yet
enforced on live BUY.

## 2. Verified facts (prod, 2026-07-08)
- `strategy_config`: `max_order_notional=50`, `max_position_pct=5`, `position_size_pct=15`,
  `trading_enabled=true`, `trading_enabled_us=true`, `trading_enabled_india=true`,
  `trading_mode='manual'`, `active_broker_us='robinhood_mcp'`, `active_broker_india='kite'`.
- Kill-switch dials read from `ks_daily_loss_pct/ks_drawdown_pct/ks_accuracy_pct` with
  hardcoded fallbacks (-5 / 20 / 40) when null/zero.
- START_NAV: US 10000, India 1000000.
- Exposure columns present: `max_gross_exposure_pct, max_sector_exposure_pct,
  max_name_exposure_pct, max_avg_pairwise_corr, max_portfolio_vol_pct,
  max_positions_per_sector` — referenced only in paper-trade + risk-profile settings +
  risk-profiles lib (grep: NOT in trader/route.ts or broker/orders/route.ts).

## 3. Gaps to fix (ranked)

### G1 — Data-integrity guard (highest ROI; drafted, not built)
Signal-quality gate so tainted/partial-data decisions can't size a real trade or pollute
learning. See `features/learning-integrity/FEATURE_ARCHITECTURE.md`. Position limits do
not catch a bad thesis.

### G2 — India (Kite) live notional cap (concrete money hole; drafted)
`app/api/kite/order/route.ts` has no `qty*price` ceiling. See Part A of
`features/self-healing-agent/FEATURE_ARCHITECTURE.md` (per-market USD/INR caps).

### G3 — Live-path portfolio-construction limits (unplanned)
Port gross/sector/name concentration + pairwise-corr + portfolio-vol + positions-per-
sector enforcement from the paper path onto the live trader/Execution Gateway. Low
current impact ($50 caps, tiny book) but structurally the live book can over-concentrate.

### G4 — Confirm `max_daily_trades` enforced on the live path
Confirmed not enforced on the live paths. If unenforced live, a stuck loop or repeated
owner clicks could exceed the daily count (rate-limit bounds burst, not daily total).

### G5 — Non-atomic live order budget/rate checks (missed)
Both live order paths count recent orders before inserting the ledger row. Concurrent
requests can all observe the same count and pass. The per-proposal unique index prevents
double-submit of one proposal, but not N distinct proposals/orders in parallel.

### G6 — Daily cumulative notional/exposure is not capped (missed)
Per-order caps do not bound total same-day risk. A user or stuck UI could submit many
separate $50 US orders or uncapped India orders, creating larger aggregate exposure than
the risk profile implies.

### G7 — Live equity fallback has no freshness bound (missed)
US notional fallback uses latest `live_account_snapshots.equity` but does not require a
recent `captured_at`. A stale high-equity snapshot can raise the cap after funds leave.

### G8 — Kill switch disables future orders but does not handle resting orders (missed)
`disableTrading()` flips `strategy_config.trading_enabled=false` and alerts, but any
already-submitted/not-filled broker orders remain at the broker unless manually reviewed.

### G9 — Kite route bypasses global/per-market trading toggles and kill switches (missed)
The India live route is owner-gated, but it does not read `strategy_config.trading_enabled`,
`trading_enabled_india`, or call `checkKillSwitches("india")` before order submission.

### G10 — Quote freshness/price source inconsistency for India live orders (missed)
Kite market orders do not fetch a quote before submit; limit orders trust user-provided
`price` only. There is no max-age check, drift check, or notional calculation in INR.

### G11 — Live SELL fallback for non-Robinhood brokers can use stale/wrong snapshot (missed)
The generic sell-if-held fallback reads the latest `live_account_snapshots.positions_json`
without filtering by broker/account/market or `captured_at`; that can authorize a SELL
using a different or stale account snapshot.

### G12 — Sizing when live NAV is unknown is not fail-closed everywhere (missed)
US Gateway fails closed when neither cap nor equity exists, but live position sizing and
Kite direct orders do not require known NAV/equity before accepting a quantity.

## 4. Non-gaps (explicitly good — do not "fix")
- Kill-switch requires human re-enable (intentional, not a bug).
- Long-only applies to NEW positions; SELL allowed on held positions (by design).
- Notional fail-closed (refuses when cap unresolvable) — keep.
- 3 screener candidates/day cap (by design; do not raise).

---

## 5. Reviewer fixes (ChatGPT)
> Ranked by money-loss potential first. All fixes preserve §6: owner-click live orders,
> no LLM-written config/money/order/code changes, additive migrations only, and no
> deletion of append-only ledgers.

- **[G2/G9/G10] India live orders have no cap, no kill switch/toggle gate, and no fresh quote** -> `app/api/kite/order/route.ts:21-45`, `:64-89`, `:96-103` -> Add submit-time checks before inserting `broker_orders`: read `strategy_config(trading_enabled, trading_enabled_india, max_order_notional_inr)`, reject if global or India trading is disabled; call `checkKillSwitches(svc, "india")`; fetch fresh INR quote via the same deterministic India quote adapter used by paper (`fetchIndiaQuote`) for MARKET orders and use `price` for LIMIT only after validating it is finite; compute `notionalInr = quantity * validationPrice`; reject if `notionalInr > max_order_notional_inr`. Also reject if quote is unavailable/stale or cap is null/non-finite. -> **Fail-behavior:** 403 for disabled/kill/cap breach, 502 for quote unavailable, 400 for invalid quantity/price; never insert/submit an uncapped Kite order. -> **Migration:** additive `ALTER TABLE strategy_config ADD COLUMN IF NOT EXISTS max_order_notional_inr numeric NOT NULL DEFAULT 4000;` and keep `max_order_notional` unchanged as legacy USD read-through until callers move.

- **[G3] Portfolio-construction limits are paper-only and absent from live submit** -> `app/api/agents/paper-trade/route.ts:145-153` uses limits; `lib/portfolio/constructor.ts:74-201` implements them; `app/api/broker/orders/route.ts:112-198` does not call them -> Extract a shared live-safe risk check, e.g. `lib/risk/live-portfolio-gate.ts`, that builds a per-market live book from current broker holdings/snapshot plus the candidate order, resolves sector and vol, then calls `constructPortfolio()` with `strategy_config` limits before `broker.submitOrder()`. For BUY orders, shrink is not acceptable on a human-approved order; require re-approval if constructor would shrink, and reject if final size is 0 or any limit would be breached. SELL orders may pass if held and reduce exposure. -> **Fail-behavior:** 409 `portfolio_limit_requires_reapproval` if allowed size differs from approved qty; 403 if no room/limit breach; 502 if holdings/NAV/sector data required for the check cannot be fetched. -> **Migration:** none if existing limit columns are used; add only an optional audit column such as `broker_orders.risk_check_json jsonb` if UI/reconciliation needs the decision snapshot.

- **[G6] Per-order cap does not cap cumulative daily exposure** -> `app/api/broker/orders/route.ts:153-167`, `app/api/kite/order/route.ts:64-89`, `supabase/migrations/068_broker_orders.sql:5-25` -> Add `broker_orders.estimated_notional numeric`, `broker_orders.currency text`, and `broker_orders.risk_reserved_at timestamptz`; populate before submit. Add `strategy_config.max_daily_live_notional_usd numeric NOT NULL DEFAULT 150` and `max_daily_live_notional_inr numeric NOT NULL DEFAULT 12000` (or Vaibhav-approved values). Before submit, sum today's active/submitted/filled BUY notionals for the same market/currency and reject if `sum + candidate_notional` exceeds the daily cap. -> **Fail-behavior:** 403 before broker submission; fail closed if candidate notional, currency, or daily cap cannot be determined. -> **Migration:** additive columns/index only; do not mutate append-only ledgers.

- **[G4/G5] Daily trade count and rolling rate checks are non-atomic / absent on live path** -> `app/api/broker/orders/route.ts:213-227`, `app/api/kite/order/route.ts:67-89`; `max_daily_trades` exists but is not read on either live path -> Create an additive SECURITY DEFINER RPC such as `reserve_live_order_budget(p_market text, p_currency text, p_notional numeric, p_max_daily_trades int, p_max_daily_notional numeric)` that runs in one transaction with `pg_advisory_xact_lock(hashtext(current_date || ':' || p_market))`, counts/sums today's `broker_orders` active/submitted/filled rows, and either returns ok or raises. Call this immediately before the broker submission ledger insert/update; alternatively make the RPC insert the `broker_orders` row itself to make the reservation durable. -> **Fail-behavior:** 403/429 if daily count or notional would be exceeded; 503 if RPC errors or cannot acquire/check the lock; never fall back to client-side count on money paths. -> **Migration:** additive RPC plus indexes on `(market, broker_env, created_at)` and optional `estimated_notional,currency` columns from G6.

- **[G8] Kill switch does not cancel or quarantine existing resting orders** -> `lib/kill-switches.ts:101-112`, `app/api/broker/orders/sync/route.ts:23-39`, broker adapters expose `cancelOrder()` in `lib/brokers/adapter-types.ts:27` but Robinhood cancel is not implemented -> Do not let an LLM or cron blindly cancel live orders. Minimal safe fix: when `disableTrading()` trips, query `broker_orders` for same-market live statuses `pending_submit/submitted/partially_filled/unknown_needs_reconcile`; create CRITICAL issues requiring owner review and mark rows with a new `risk_status='kill_switch_review_required'`. Add an owner-only cancel endpoint/button that calls adapter `cancelOrder()` only after human click; for Robinhood MCP, keep cancel disabled until deterministic cancel is implemented and tested. -> **Fail-behavior:** new order submission remains blocked immediately; open orders are visibly quarantined for human action; no autonomous cancel/place from cron/LLM. -> **Migration:** additive `broker_orders.risk_status text`, `risk_status_at timestamptz`, optional `risk_status_reason text`; no deletes.

- **[G7] Live equity fallback cap accepts stale snapshots** -> `app/api/broker/orders/route.ts:157-161`, `app/api/live-account/refresh-snapshot/route.ts:69-75` -> When using equity fallback, select `equity,captured_at`; require `captured_at >= now() - interval '5 minutes'` for market-hours live orders (or explicitly configured max age). If stale, refuse and instruct user to refresh the live account snapshot or set explicit per-market cap. Prefer explicit `max_order_notional_usd` over fallback. -> **Fail-behavior:** 403 before broker submission if snapshot missing/stale; never use stale equity to raise a cap. -> **Migration:** additive `strategy_config.max_order_notional_usd numeric NOT NULL DEFAULT 50`; keep legacy `max_order_notional` as read-through for one release.

- **[G1] Data-integrity guard is not enforced before live sizing/submission** -> `features/learning-integrity/FEATURE_ARCHITECTURE.md`; live proposal submit currently trusts `trade_proposals` in `app/api/broker/orders/route.ts:77-83` -> Add a deterministic pre-submit read joining `trade_proposals.signal_id` to the latest `decision_observations`/quality view once `trade_proposals.signal_id` is migrated to uuid; require `quality_status='clean'` or explicit owner override recorded on the proposal. Block degraded/tainted/unknown signals from live BUY sizing. Do not let the explainer/LLM synthesize missing evidence. -> **Fail-behavior:** 403 `signal_quality_blocked` for tainted/unknown/degraded BUY; SELL reducing held risk may pass with journal note. -> **Migration:** additive quality columns/views only, plus required type migration of `trade_proposals.signal_id` bigint -> uuid before trusting joins; no deletes/updates to append-only `decision_observations`.

- **[G11] Generic live SELL snapshot check can use wrong/stale account** -> `app/api/broker/orders/route.ts:189-195` -> Replace the generic fallback with broker-specific holdings adapters. If a broker does not provide account-scoped fresh holdings, reject SELL rather than using unfiltered `live_account_snapshots`. At minimum filter snapshot by resolved `acct.account`, `market`, and freshness (`captured_at` max age) before checking `positions_json`. -> **Fail-behavior:** 403 if current account-scoped holdings cannot be verified; never authorize a SELL from another account's cached position. -> **Migration:** none if `live_account_snapshots.account_id` is present; add index `(account_id, captured_at desc)` if missing.

- **[G12] Live sizing/NAV unknown should fail closed** -> `app/api/broker/orders/route.ts:153-164` has a partial US cap fail-closed path; `app/api/kite/order/route.ts:21-45` has no NAV/cap dependency; `app/api/agents/trader/route.ts:280-285` builds proposals from paper NAV -> For live BUY submit, require either explicit per-market notional cap or fresh account equity/NAV; never use paper NAV to justify live quantity. If live NAV/equity is unknown, reject and ask for account snapshot refresh. Trader proposal generation may remain advisory, but final Execution Gateway must recompute money limits from live account state. -> **Fail-behavior:** 403 before broker submission on missing live NAV/equity/cap. -> **Migration:** covered by G2/G7 per-market cap columns.

- **[Scorecard downgrades] Controls graded too high** -> `RISK_MANAGEMENT_AUDIT.md §1` -> Downgraded circuit breakers A->B, operational safety A->B, position sizing A- -> B paper/C live, exit management A- -> B paper/D live, US per-order B+->B, India C->D, portfolio construction B paper/D live -> B paper/F live, and overall paper A-/live B/B- -> paper B+/live C. -> **Fail-behavior:** documentation-only correction; prevents false confidence until enforcement exists. -> **Migration:** none.

## 6. Project safety rules the fixes must not violate
- New positions long-only; SELL only on held positions.
- Live orders require an owner human click; never cron-callable.
- No LLM autonomously changes weights, money-limits, config, code, or places/cancels orders.
- Schema-coupled code ships only after its migration is applied to the target DB.
- Max 3 screener candidates/day; no explicit bull/bear regime switching.
- Additive migrations only near append-only ledgers; never delete `decision_observations`,
  `observation_labels`, `paper_order_events`, `learning_log`, `strategy_versions`.

---

## 7. Implementation status (Claude, 2026-07-08)

Shipped to `main` (Vercel), migration-first (each migration applied + verified before its code):

- **G2/G9/G10 — FIXED.** Per-market notional caps (USD/INR, Settings-editable, migration 103);
  Kite route now gated by `trading_enabled`/`trading_enabled_india` + `checkKillSwitches("india")`
  + fresh-quote INR notional cap (fail-closed).
- **G4/G5/G6 — FIXED.** `reserve_live_order_budget()` RPC (migration 105): atomic, advisory-locked
  daily BUY trade count + cumulative notional; both caps Settings-editable; closes the TOCTOU race.
- **G7 — FIXED.** US equity-fallback cap requires a snapshot ≤30 min old, else fail-closed.
- **G8 — FIXED (minimal).** Kill switch flags resting live orders `kill_switch_review_required` +
  CRITICAL alert (migration 106). No auto-cancel (deterministic broker cancel not wired).
- **G11 — FIXED.** Live SELL fallback scoped to the resolved account + ≤30 min freshness; fail-closed.
- **G12 — COVERED** by G2/G7 (Gateway derives money limits from config caps / fresh equity, never paper NAV; Kite fail-closes).
- **G1 — LIVE BUY ENFORCED.** Migration 108 fixed `trade_proposals.signal_id` bigint→uuid (was a
  latent bug — the trader wrote a uuid into a bigint column, so proposals never linked). The
  Execution Gateway now refuses a live BUY when the linked decision's `data_confidence` < 0.5,
  `quality_status != 'ok'`, or there's no linked quality record; owner override `acceptLowQuality:true`.
  The **learner** side (auto-exclude tainted closed trades) is still deferred pending US calibration —
  the view stays measure-only for the learner; only the deterministic live-BUY gate is enforced.
- **G3 — BLOCKED (data prerequisite).** The %-of-NAV limits (gross/sector/name/vol) can't be computed:
  `live_account_snapshots.equity` is NULL (the Robinhood MCP account response doesn't expose portfolio
  value under the parsed field names) and positions carry no sector. Prerequisite before G3: capture live
  equity (confirm what RH's account endpoint returns via an authed snapshot refresh) + resolve per-position
  sector — OR reformulate live limits in absolute-notional terms (partly covered already by the per-order +
  daily notional caps). Not completable headless.

Remaining: **G3** (blocked on live-NAV capture — see above) and **self-healing Part B** (health-triage
agent, designed in `features/self-healing-agent`, not built).
