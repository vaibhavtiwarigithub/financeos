# Claude Code prompt — verify and fix the post-upgrade audit

You are the Builder for Kairos/FinanceOS. Work in:

`C:\Users\vaibh\OneDrive\Documents\Startup\FinanceOS`

Read in this order before editing:

1. `AGENTS.md`
2. `WORK_LOG.md`
3. `PRD.md`
4. `knowledge/KNOWLEDGE_INDEX.md`
5. `knowledge/CONNECTIONS.md`
6. `CODEX_REMEDIATION_REVIEW_RESULT.md`
7. `CODEX_POST_UPGRADE_DEEP_REVIEW_RESULT.md`
8. `CODEX_FULL_SYSTEM_AUDIT_RESULT.md` section “Target architecture upgrade”

Your job is to **verify every finding against current code, fix only findings that are real, and prove each fix**. Do not dismiss a finding from comments, docs, prior commits, or a green unit suite. The previous implementation reintroduced the original zero-signal bug under a different column name and created unsafe live exits. Treat real money as adversarial.

## Non-negotiable execution order

### Phase 0 — stop and inventory

- Claim this task in `WORK_LOG.md`.
- Confirm `AUTONOMOUS_LIVE_ENABLED` remains false in every deployed environment. Do not enable it.
- Produce `POST_UPGRADE_FIX_LOG.md` with one row per Codex finding: `finding → confirmed/rejected → evidence → fix → tests`.
- Inspect production Supabase through the connected project, but never rely on manual production state as the migration source. Capture function/policy definitions before changing them.

### Phase 1 — P0 live-money and schema fixes only

Implement these before any scoring enhancement:

1. **Reproducible migration repair**
   - Add a new additive migration; do not rewrite already-applied migrations.
   - Restore every missing `strategy_config.live_auto_*` column/default/check and any missing proposal/order constraints.
   - Harden `reserve_live_order_budget_v2`: `REVOKE` from `PUBLIC`, `anon`, `authenticated`; grant service-role only; fixed `pg_catalog,public` search path; validate actor, market, side, env, positive integral quantity, finite positive estimated BUY notional, expected currency, nonnegative caps, and proposal identity.
   - Keep advisory locking and active/ambiguous BUY budget accounting.
   - Prove clean migration replay on a disposable DB and compare schema/function hashes with production.

2. **Correct immutable confidence and strategy lifecycle**
   - Do not read `agent_signals.confidence` for autonomous evidence.
   - Resolve the exact `decision_observations`/`v_decision_quality` row by `signal_id`, market, timestamp and strategy version. Require weighted structural confidence and quality status.
   - Add/use an actual `strategy_version_id` FK on signals. Paper must require a paper-eligible state; autonomous live must require same-market `live_approved`.
   - Unknown/null/schema errors fail loudly and generate persistent health alerts.

3. **Enforce autonomous authority inside the shared gateway**
   - For `autonomous_worker`, re-read and require deployment flag, `autonomy_level >= L4_live_small_auto`, DB toggle, unexpired owner lease, per-market mode=`autonomous`, and per-market trading flag=true inside `executeApprovedOrder` or a single called authorization function.
   - Upstream cron checks are optimization, not authorization.
   - Autonomous overrides remain impossible.

4. **Remove cross-currency and cross-market sizing**
   - Use explicit money types `{amount,currency}` or distinct USD/INR fields for per-order and daily caps.
   - Assert NAV, quote, order notional and caps share the same currency.
   - Filter calibration/Kelly inputs by market, strategy version, setup and horizon.
   - In autonomous live, missing validated edge means size zero; no flat fallback.
   - India quote freshness must use NSE/Kite/Yahoo timestamp and India session, never US market hours.

5. **Use official Robinhood Trading MCP**
   - Delete/disable the unofficial `api.robinhood.com` live-write workaround unless Robinhood provides explicit official documentation and a separately authorized token for it.
   - Build a server-side remote MCP client for `https://agent.robinhood.com/mcp/trading` using its OAuth/session support.
   - Discover tool schemas at runtime/startup; call `review_equity_order`; validate account=`605420660`, symbol, side, quantity, order type and warnings; then call `place_equity_order` deterministically.
   - Implement `get_equity_orders` and `cancel_equity_order` for reconciliation. Never let an LLM call the write tool.
   - If serverless OAuth/token acquisition cannot be implemented from confirmed metadata, keep live auto blocked. Do not guess endpoints or reuse a token on a private API.

6. **Rebuild live exits before live entries**
   - Make broker positions/open orders the authority per account+market.
   - Add an atomic `(account,market,symbol,position_epoch)` exit claim and calculate `sellable_qty = held - open_sell_remaining` under lock.
   - Handle partial fills, cancel races, corporate actions, transfers, and ambiguous responses.
   - Risk-reducing exits must continue when new entries/auto are disabled or a trading kill switch trips. Define separate security-lock emergency behavior explicitly.
   - Cancel-on-kill cancels only exposure-increasing BUYs, never protective SELLs. Use `cancel_requested` until broker confirms terminal status.
   - Implement India/Kite broker-native GTT/bracket protection and monitoring before India auto BUY can be eligible.
   - Prefer broker-native protective orders. A 30-minute cron alone is not sufficient protection.

7. **Use live risk for live money**
   - Split paper and live kill-switch inputs.
   - Live daily loss/drawdown/exposure uses fresh broker/account snapshots per market/currency.
   - A US trip updates US enablement only; India likewise. Preserve an explicit global emergency kill.
   - Stale/missing live NAV fails closed for new BUYs and alerts, but does not suppress verified risk-reducing exits.

8. **Durable order lifecycle**
   - Every reserve, submit attempt, ambiguous result, accepted, partial fill, fill, cancel request, cancel, reject, expire and reconciliation transition updates current state and appends `broker_order_events`.
   - Check every DB result. If broker success may have occurred but persistence fails, issue critical out-of-band alert and block retry.

Do not continue to Phase 2 until the Phase-1 clean-reset, auth/RLS, money-path and concurrency tests pass.

### Phase 2 — discovery/scoring integrity (shadow/measure-only first)

1. **Fix US candidate discovery**
   - Rename the current fundamental-growth bucket honestly; it is not momentum.
   - Create a deterministic eligible universe with price, ADV, spread, history, market-cap and tradability floors.
   - Define provider sort explicitly and record the full candidate set, not only six returned names.
   - Compute point-in-time cross-sectional features before selecting the daily top candidates.

2. **Fix India discovery**
   - Require `scored_at` freshness and reject stale cache rows.
   - Add liquidity/ADV/price/market-cap/spread/history filters.
   - Do not select simply the highest RSI or lowest P/E. Use rank composites after data-quality gates.
   - Version NSE universe membership and include delistings where historical tests require it.

3. **Build two real specialist models in shadow**
   - `quality_catalyst_momentum`: 12–1/6–1 momentum, sector-relative strength, 52-week high, resistance breakout, volume persistence, volatility adjustment, earnings/revenue/gross-margin acceleration, guidance delta, estimate-revision breadth, SUE/PEAD, cash/accrual quality.
   - `turnaround_inflection`: improving revisions/margins/cash flow/capital discipline plus delayed technical confirmation; designed for Intel/SanDisk-like early inflections without pretending a falling stock is trend momentum.
   - Add a semiconductor/memory feature module only where point-in-time reliable data exists: DRAM/NAND pricing, inventory, utilization/capex, HBM/datacenter mix, gross-margin and guidance revisions.
   - These write measure/shadow evidence only until validation passes.

4. **Add deterministic fast-breakdown/crowding defense**
   - Large negative gap/return versus ATR; close-location value; downside volume shock; failed breakout/gap retention; EMA/breakout loss; volatility explosion; parabolic distance; spread/liquidity deterioration; social/short-interest crowding where reliable.
   - A severe breakdown is a veto/quarantine/exit condition, not a small score subtraction.
   - Add the exact regression fixture: a parabolic sequence followed by −12% on 3× volume must not score 100 or remain entry-eligible. A +trend followed by −6% high-volume conflict must receive a bearish volume/reversal penalty.

5. **Repair dimension formulas**
   - Fundamental subfeatures renormalize within applicable/available fields; missingness affects uncertainty, not arbitrary point opportunity.
   - Replace hardcoded sector P/E priors with point-in-time market/sector ranks; add ROIC/gross profitability/leverage/cash conversion/accrual/inventory/dilution controls.
   - Replace static analyst target upside with revision direction, breadth and velocity where data supports it.
   - Sentiment uses sample-size Bayesian shrinkage, source quality, novelty/velocity and crowding cap.
   - Macro is separate for US and India and mapped to sector/setup exposure; use as an exposure scaler initially.

6. **Make rank and forecasts actionable only after proof**
   - Produce calibrated expected excess return, p-positive, downside quantile and uncertainty per setup/horizon.
   - Portfolio construction chooses from the full eligible cross-section under cost/liquidity/correlation/sector/turnover/tax constraints.
   - Do not promote a heuristic rank directly into live trading.

### Phase 3 — real governed evolution

- Replace univariate correlation weight nudging with regularized multivariate walk-forward research by market/setup/horizon.
- Track every research trial and apply multiple-testing control/Deflated Sharpe or equivalent.
- Remove `force_unvalidated` from normal promotion. If an emergency owner override exists, it remains paper-only with step-up confirmation and a distinct state.
- Demote/promote champion transactionally with one champion per market constraint; remove pre-migration unscoped fallbacks.
- Lifecycle: hypothesis → measure → purged walk-forward → shadow → paper A/B → owner live review → tiny live canary → scale/retire.
- Feature Registry and Edge Lab may feed only versioned shadow challengers, never money directly.
- Calibration artifacts deploy only after OOS Brier/log-loss/ECE and baseline comparison pass.

## Required tests — not optional

Add tests that call the actual services/RPCs, not comments or duplicate pure logic:

1. clean database replay from migration 001 through latest;
2. RPC permission matrix: anon/non-owner/owner cannot reserve; service-role can;
3. every manual gateway invariant and HTTP status remains unchanged;
4. autonomous worker fails at L3, null/expired lease, wrong market mode, non-live-approved version, missing quality, and currency mismatch;
5. one valid US and one valid India fixture reach mocked broker submit exactly once;
6. simultaneous cron calls create one proposal/reservation/order;
7. ambiguous submit never retries;
8. partial fill + second exit-monitor run cannot oversell;
9. auto-disable/kill blocks BUY while protective SELL remains available;
10. cancel-on-kill never cancels SELL and reconciles cancel/fill race;
11. stale India cache and stale India quote cannot enter/size;
12. US and India NAV/caps/Kelly/models never cross-contaminate;
13. broker response persistence failure triggers reconcile/critical alert;
14. point-in-time label/universe fixtures cannot access future records;
15. MU/INTC/SNDK/GME-style frozen historical packets run without future data and report whether/when each model becomes eligible—no handpicked future-return dates;
16. parabolic-reversal technical regression described above;
17. full `npm test`, typecheck, build, browser smoke, and Supabase advisor checks.

## Deliverables

- Code and additive migrations for confirmed findings.
- `POST_UPGRADE_FIX_LOG.md` with evidence for every finding.
- `POST_UPGRADE_TEST_EVIDENCE.md` containing commands, outputs, schema hashes, test fixtures and before/after counts.
- Updated architecture docs only after behavior is proven.
- Do not enable autonomous live, change owner money caps, place real orders, or apply a production migration without Vaibhav’s explicit approval.

When finished, report honestly what remains blocked. “Build green” or “R1–R18 done” is not completion unless the above money-path, SQL, concurrency, historical-PIT, and India/US tests pass.
