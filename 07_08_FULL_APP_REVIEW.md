# Kairos / FinanceOS full application review — 2026-07-11

Reviewed/updated by ChatGPT (Codex), 2026-07-11. This is a current-tree and live-database review, not a restatement of prior audits.

## Executive verdict

Kairos is **not safe enough for unattended live money and is not yet statistically capable of claiming self-improvement or market-beating ability**. Manual live trading has useful deterministic controls, but the current deployment is more permissive than the review prompt assumed: live trading is enabled for US and India at `L3_live_manual`. The autonomous deployment/database switches are off, so unattended entries are presently blocked.

Architecturally, the project has several genuinely strong foundations: a shared US execution service, account allowlisting for Robinhood, atomic daily-budget reservation, reconciliation states, immutable evidence tables, point-in-time/replay scaffolding, deterministic scores, explicit strategy versions, and paper/live separation. The weakness is the gap between **implemented scaffolding** and **working evidence**. Live Supabase currently has 11 paper trades, no observation labels, no shadow decisions, no model artifacts, no replay packets, and no trade memories. That means the learner, calibration, walk-forward promotion, replay, RAG, and archetype comparison layers have not produced evidence that can improve decisions.

Top five blockers:

1. [CONFIRMED] Kill-switch semantics are wrong for live money: manual-live checks can use paper metrics, snapshots can be stale, fixed `START_NAV` can create false drawdowns, and a tripped kill switch blocks held-only risk-reducing SELLs.
2. [CONFIRMED] India live ordering remains a parallel gateway that does not resolve an explicit allowlisted account and calls a legacy RPC exposed to `anon`/`authenticated` in the deployed database.
3. [CONFIRMED] A successful broker submit can be returned as success even if the durable `broker_orders` update fails, leaving a live order without a trustworthy reconciliation key.
4. [CONFIRMED] Paper NAV/performance truth is currently corrupted because PositionMonitor updates a nonexistent `paper_portfolio.open_positions` column and ignores the error.
5. [CONFIRMED] The system is not learning yet: all statistically important evidence stores are empty, while the remaining LearnerAgent weight proposal uses small-sample univariate Pearson correlation rather than a validated multivariate, horizon-aligned optimizer.

No honest reviewer can promise that any trading application will beat the best traders in every economic regime. The correct target is positive net-of-cost out-of-sample expectancy with controlled drawdown, calibrated uncertainty, and an explicit ability to abstain. Kairos has a plausible path to that target, but it has not demonstrated it.

## Risk ranking summary

| Rank | Severity | Area | Issue | Money-loss / product risk | Fix owner |
|---|---|---|---|---|---|
| 1 | CRITICAL | Live risk | Kill switch chooses paper/live data from `live_auto_enabled`, accepts stale snapshots/fixed baselines, and blocks protective SELLs | Live BUYs can be evaluated from the wrong book; exits can be frozen during stress | Senior builder + risk reviewer |
| 2 | CRITICAL | India execution | Kite route is a separate live gateway with no active-account/allowlist resolution | Orders can hit whichever Kite identity is in Vault, while config has `active_account_india = null` | Senior builder |
| 3 | CRITICAL | Execution durability | Broker success is not conditioned on durable order-state persistence | A real order can exist while the ledger remains `pending_submit` without broker ID | Senior builder |
| 4 | CRITICAL | Paper truth | PositionMonitor writes missing `open_positions`; entire NAV update fails silently | Performance, sizing evidence, kill switches, and learning consume false NAV | Senior builder + DB migration |
| 5 | HIGH | Database security | Legacy SECURITY DEFINER budget RPC is executable by anon/authenticated | External callers can forge approved ledger reservations and poison daily budget | DB/security owner |
| 6 | HIGH | Budget correctness | v2 budget RPC uses UTC day rather than market-local day | Orders near US/India day boundaries are counted in the wrong session | DB/risk owner |
| 7 | HIGH | Strategy governance | Champion promotion mutates an append-only version ledger and demote/promote is not atomic | Zero or inconsistent champion can occur; historical state is rewritten | Architect + DB builder |
| 8 | HIGH | Learning | No labels/shadows/artifacts/replay/memories exist; Pearson weight nudging remains statistically weak | “Self-improving” behavior is currently non-operational or noise-prone | Quant/ML builder |
| 9 | HIGH | Discovery/scoring | Candidate discovery is narrow, static, and not sufficient for early inflection detection | Misses emerging leaders or admits noisy/illiquid momentum names | Quant researcher + builder |
| 10 | HIGH | API security/reliability | Unauthenticated service-role routes can write DB and consume provider quota | Quota exhaustion, cache pollution, alert spam, proprietary data exposure | Security builder |
| 11 | MED | Rank gate | Rank enforcement is fail-open, can affect rows outside the run, and mishandles unscoped mixed-market runs | A promoted rank rule may not actually constrain paper/live candidates | Builder |
| 12 | MED | PIT data | Fundamental archive updates “immutable” rows, is non-atomic, and usually lacks filing/report dates | Replay can label captured time, but cannot reconstruct historical availability before capture | Data builder |
| 13 | MED | Build/runtime | TypeScript check fails; localhost returned HTTP 500 | Current tree cannot be considered release-verifiable | Builder |
| 14 | MED | Supabase | Security-definer views and mutable-search-path functions remain in deployed DB | RLS bypass and search-path attack surface | DB/security owner |
| 15 | MED | Scheduling | Research idempotency is check-then-insert and holiday calendars are incomplete | Duplicate runs/costs or stale-market signals | Builder |

## P0 — must fix before live trading or autonomous mode

### P0-1 — Separate live-entry risk checks from paper checks and never freeze held-only exits
- Severity: CRITICAL
- Files: `lib/kill-switches.ts`, `lib/trading/execute-order.ts`, `lib/trading/live-exit-monitor.ts`, `app/api/kite/order/route.ts`
- Exact location: `lib/kill-switches.ts:115-172,222-270`; `lib/trading/execute-order.ts:175-188,263-292`; `lib/trading/live-exit-monitor.ts:45-61,146-150`
- Confidence: [CONFIRMED]
- What is wrong: `checkKillSwitches()` decides whether to read live or paper metrics from `strategy_config.live_auto_enabled`. Manual-live trading at L3 therefore uses paper performance whenever autonomous mode is off. Live snapshots have no maximum-age check. `peak90` is forced above static `START_NAV` (US 10,000; India 1,000,000), although the live agentic US account currently has only $36.56 equity. Finally, `executeApprovedOrder()` applies `if (!ks.safe) return` to BUY and SELL, so a tripped switch blocks the protective exit monitor and owner SELLs.
- Concrete failure scenario: Owner enables manual live US trading while `live_auto_enabled=false`; a BUY is accepted/rejected from paper drawdown and paper accuracy rather than account 605420660. If a live loss later trips the switch, a stop SELL is routed through the same function and is rejected by that switch.
- Why this matters: A kill switch must prevent risk expansion, not prevent risk reduction, and it must measure the book being traded.
- Specific fix: Replace the implicit mode choice with `checkKillSwitches(supabase, { market, book: "paper" | "live", accountId })`. Live callers must pass the resolved allowlisted account. Require a valid positive snapshot no older than a configurable maximum (15–30 minutes at submit; end-of-day series for historical peaks). Establish peak from the account's first/owner-approved baseline snapshot, not global constants. Apply kill-switch rejection to BUY/new exposure only. Permit SELL only after fresh exact-account held-quantity verification, while preserving security lock and broker availability checks.
- Required migration if any: Add an additive `live_risk_baselines(account_id, market, currency, baseline_equity, effective_at, set_by, created_at)` event table or equivalent immutable baseline event; optionally add snapshot source/currency constraints.
- Fail behavior: Live BUY fails closed on missing/stale account data. Held-only SELL remains available unless identity/holding verification fails or the global security lock is active.
- Tests/verification: Unit tests for paper/manual-live/auto-live selection; stale snapshot; $36.56 account not compared with $10,000; kill-switch BUY blocked and SELL allowed; exact-account over-sell rejected.
- Can a basic LLM fix this mechanically? no — it spans safety semantics and must be reviewed by a risk engineer.

### P0-2 — Eliminate the parallel Kite money path and require explicit account identity
- Severity: CRITICAL
- Files: `app/api/kite/order/route.ts`, `lib/trading/execute-order.ts`, `lib/brokers/adapters/kite.ts`, `lib/kite.ts`
- Exact location: `app/api/kite/order/route.ts:18-95,122-213,231-254`; `lib/trading/execute-order.ts:153-207,263-292,314-336`
- Confidence: [CONFIRMED]
- What is wrong: India still submits directly through `/api/kite/order` instead of the shared execution service. It does not require `active_account_india`, resolve a `broker_accounts` trading allowlist row, or bind the Vault token/profile to that configured account. Live DB has `trading_enabled_india=true` and `active_account_india=null`.
- Concrete failure scenario: A valid owner click reaches the currently authenticated Kite account even though no India trading account is selected in strategy config.
- Why this matters: Account selection is part of order authorization, not a display preference.
- Specific fix: Make `/api/kite/order` a thin owner/CSRF adapter that creates/loads a canonical `trade_proposals` row and calls `executeApprovedOrder()`. Extend the Kite adapter's `isConfigured/submitOrder` contract to verify Kite `user_id` from `/user/profile` against `active_account_india` and an allowlisted `broker_accounts` row. Remove direct broker submission and v1 budget RPC use from the route.
- Required migration if any: Additive unique constraint on `(broker, market, account_number)` if absent; seed the confirmed Kite identity only after owner verification.
- Fail behavior: Any absent/mismatched account, profile-read error, or allowlist miss returns 403 before reservation/submission.
- Tests/verification: Active account null; wrong Kite user; stale/expired token; correct account; BUY/SELL parity with US gateway; ambiguous response reconciliation.
- Can a basic LLM fix this mechanically? no — broker identity must be verified with a real read-only Kite profile response.

### P0-3 — Do not report broker success until durable truth is persisted
- Severity: CRITICAL
- Files: `lib/trading/execute-order.ts`
- Exact location: `lib/trading/execute-order.ts:336-363`
- Confidence: [CONFIRMED]
- What is wrong: After `broker.submitOrder()` succeeds, the updates at lines 352–354 and journal insert at 356–361 ignore Supabase errors. The function returns `{ok:true}` regardless. If the update fails, the reserved row remains `pending_submit` without `broker_order_id`, even though the broker order exists.
- Concrete failure scenario: Robinhood/Kite accepts an order, then Supabase briefly fails. UI says success; automatic reconciliation lacks the known broker ID; retry/duplicate handling is unsafe.
- Why this matters: Durable order truth is the basis of exposure, reconciliation, exits, and duplicate prevention.
- Specific fix: Persist an append-only `broker_order_events` “broker_acknowledged” event containing the broker ID and raw state, then update the current projection. Check both results. Retry boundedly on transient DB errors. If acknowledgment cannot be durably stored, emit a critical alert with the known broker ID and return HTTP 202 / `needs_reconcile=true`, never normal success. Do not resubmit.
- Required migration if any: None if `broker_order_events` supports this event; otherwise additive event type/check update.
- Fail behavior: Broker-accepted/database-unknown is always ambiguous/reconcile, never success and never automatic retry-submit.
- Tests/verification: Inject failure into event insert and projection update after broker success; assert no resubmit and a 202/critical alert with broker ID.
- Can a basic LLM fix this mechanically? yes, if tests use injected Supabase failures and no broker call is repeated.

### P0-4 — Repair paper portfolio truth before using paper evidence
- Severity: CRITICAL
- Files: `app/api/agents/position-monitor/route.ts`, `supabase/migrations/*`
- Exact location: `app/api/agents/position-monitor/route.ts:327-340`
- Confidence: [CONFIRMED]
- What is wrong: PositionMonitor updates `paper_portfolio.open_positions`, but that column does not exist in deployed Supabase. PostgREST rejects the whole update and the code ignores the result. Live DB proves the damage: India reports NAV 847,199.53, cash 406,518.23, `total_invested` 593,481.77, `total_pnl=0`, and `total_trades=0` despite 8 India trades and three closed outcomes. The latest open-position marks imply another NAV, not 847,199.53.
- Concrete failure scenario: Position closes and cash is credited in memory, but the portfolio update fails; the displayed NAV, performance series, drawdown gate, and learning labels diverge.
- Why this matters: No performance or learning conclusion is valid on inconsistent accounting.
- Specific fix: Prefer removing `open_positions` from the update unless the UI truly needs it; otherwise add the column first. Check every update/upsert error and fail the run visibly. Rebuild NAV as a deterministic projection from cash events plus open lots, and write an append-only reconciliation event recording old/new/delta rather than silently rewriting historical ledgers. Add an invariant check: `nav == cash + sum(qty*current_price)` within currency precision.
- Required migration if any: Optional additive `open_positions integer`; recommended additive `paper_portfolio_reconciliation_events` and constraints for market/currency.
- Fail behavior: A projection write failure marks the agent run failed and raises a health alert; it must not claim a successful monitor run.
- Tests/verification: Clean-DB close, partial close, two markets, update error injection, NAV invariant, totals agree with trades.
- Can a basic LLM fix this mechanically? yes for the missing-column/error check; no for historical reconciliation policy.

### P0-5 — Revoke exposed legacy budget RPC and make session budgeting market-local
- Severity: HIGH
- Files: `supabase/migrations/121_reserve_budget_reproducible.sql`, migration 140/147 definitions, new additive migration
- Exact location: `supabase/migrations/121_reserve_budget_reproducible.sql:12-56`; deployed routine grants verified 2026-07-11
- Confidence: [CONFIRMED]
- What is wrong: Live DB grants EXECUTE on `reserve_live_order_budget(...)` to `anon` and `authenticated`, although it is SECURITY DEFINER and inserts `broker_orders` with `approved_by_user=true`. The recreated 14-argument overload in migration 121 did not repeat the revoke/grant statements. v2 is correctly limited to service role, but uses UTC `current_date/date_trunc('day',now())` rather than each market's trading date.
- Concrete failure scenario: A caller with the public project key invokes v1 to insert fake pending live orders, poison daily budgets, and forge “approved” ledger rows. Around 7/8 PM ET or 05:30 IST, v2 counts the wrong market day.
- Why this matters: It corrupts the authoritative order ledger and daily risk envelope.
- Specific fix: Add a migration that revokes v1 from PUBLIC, anon, and authenticated; either revoke service_role too and retire it after Kite unification, or keep only service_role temporarily. Update v2 with `America/New_York`/`Asia/Kolkata` session date, lock key including broker/account/market/date, strict positive finite inputs, currency-market validation, and explicit allowed status policy.
- Required migration if any: Yes, additive migration 152+; never edit an applied migration.
- Fail behavior: Direct anon/auth call gets permission denied. Invalid currency/date/cap input raises before insert.
- Tests/verification: Query `information_schema.routine_privileges`; concurrent boundary-time tests for both markets; fake currency and negative notional tests.
- Can a basic LLM fix this mechanically? yes, with exact SQL and database integration tests.

### P0-6 — Turn manual live mode off until P0 acceptance is green
- Severity: HIGH
- Files: deployment/configuration, not source code
- Exact location: live `strategy_config` row queried 2026-07-11
- Confidence: [CONFIRMED]
- What is wrong: The review prompt says paper-only, but live DB has `trading_enabled=true`, both market flags true, `autonomy_level=L3_live_manual`, Robinhood enabled, US cap $500, India cap ₹20,000, and India has no selected account.
- Concrete failure scenario: An owner click can reach live broker paths while the P0 defects above remain.
- Why this matters: Human approval reduces but does not eliminate wrong-account, stale-risk, or durability defects.
- Specific fix: Owner should set `trading_enabled=false` and market flags false until P0-1 through P0-5 tests pass. This review did not mutate configuration.
- Required migration if any: None.
- Fail behavior: All live entries and manual live submissions return 403; paper/shadow continue.
- Tests/verification: Read-only config check plus route tests.
- Can a basic LLM fix this mechanically? no — changing live trading state requires explicit owner action.

## P1 — must fix before trusting agent recommendations

### P1-1 — Replace “components exist” with an operational evidence pipeline
- Severity: HIGH
- Files: label maturation route/schedule, `lib/learning/*`, `lib/validation/*`, shadow evaluation, replay runner, RAG indexer
- Exact location: live DB evidence counts; `lib/validation/engine.ts:125-193`; `lib/validation/calibration.ts:139-233`
- Confidence: [CONFIRMED]
- What is wrong: Deployed counts are: 210 observations, 0 observation labels, 0 shadow decisions, 0 model artifacts, 0 replay packets, 0 trade memories, 11 paper trades. All 210 observations have `evidence_confidence=null` because no post-deployment run has populated the new field. Edge catalog is 7 `measure_only`, 1 `benched_negative`.
- Concrete failure scenario: UI/docs describe self-improvement, but no challenger can obtain statistically valid labels, OOS calibration, replay eligibility, or shadow comparison.
- Why this matters: Empty evidence cannot prove edge or improvement.
- Specific fix: Build one owner-visible “learning readiness” contract with per-market counts and blockers. Ensure daily label maturation creates 5/10/20-day benchmark-neutral labels; run calibration only after minimum samples; run replay; then shadow candidates. Do not promote or size from any empty stage. Backfill only from genuinely point-in-time inputs.
- Required migration if any: None unless adding a readiness view/event.
- Fail behavior: “Not ready/insufficient data” is explicit and trading behavior remains champion/static; never synthesize confidence.
- Tests/verification: Seed dated observations/candles; mature labels deterministically; produce OOS artifact; produce shadow decisions; verify no future data.
- Can a basic LLM fix this mechanically? no — requires end-to-end data acceptance testing.

### P1-2 — Retire Pearson-correlation weight nudging as an optimizer
- Severity: HIGH
- Files: `app/api/agents/learner/route.ts`, `lib/validation/calibration.ts`, `lib/validation/engine.ts`
- Exact location: `app/api/agents/learner/route.ts:252-304,418-531,746-790`
- Confidence: [CONFIRMED]
- What is wrong: LearnerAgent still proposes weight changes from one-dimension-at-a-time Pearson correlation, with a minimum of 10 observations and `abs(correlation)` treated as “confidence.” Correlated dimensions, multiple testing, regime dependence, nonlinearity, selection, horizon overlap, and costs are not handled. A 0.70 correlation threshold on 10 points is simultaneously unstable and so restrictive that evolution may never occur.
- Concrete failure scenario: One outlier makes technical score look predictive and creates a challenger, or real multivariate edge is missed because its marginal correlation is weak.
- Why this matters: This is not valid causal credit assignment.
- Specific fix: Keep Pearson only as a diagnostic. Let the LLM propose features/hypotheses, never numeric production weights. Use deterministic regularized logistic/ridge models or bounded Bayesian optimization over a small typed genome, nested walk-forward validation with purging/embargo, market/horizon cohorts, net-of-cost utility, multiple-testing correction/deflated Sharpe, and shadow promotion. Require stability across folds and regimes.
- Required migration if any: Add immutable experiment/model artifact metadata if current tables lack optimizer/fold/dataset hashes.
- Fail behavior: Insufficient/unstable evidence produces no challenger.
- Tests/verification: Synthetic correlated features, outlier, regime flip, leakage, horizon overlap, and null-edge data.
- Can a basic LLM fix this mechanically? no — quant methodology review required.

### P1-3 — Redesign discovery to find early inflections without chasing meme breakdowns
- Severity: HIGH
- Files: `lib/research-agent.ts`, India screener/cache builder, `lib/data/technicals.ts`, `lib/data/scores.ts`, edge/rank pipeline
- Exact location: `lib/research-agent.ts:319-409,476-547,566-609`; `lib/data/technicals.ts:172-267`
- Confidence: [CONFIRMED]
- What is wrong: US “momentum” discovery is a quarterly fundamental screen sorted by revenue growth, not price/earnings-revision/relative-strength inflection. India selection is RSI>60+MA50 or P/E<35+ROE>0 with no explicit traded-value, spread, size, or sector-relative filter in the selection query. The breakdown veto is useful but uses fixed global thresholds. Rank and PIT improvements are off by default.
- Concrete failure scenario: MU/INTC/SNDK-style turns may not enter the universe until quarterly growth is already obvious; an India high-RSI illiquid name can outrank a liquid leader; a meme squeeze passes momentum, then collapses after the fixed veto window.
- Why this matters: A scorer cannot select a stock it never observes, and early detection is a universe/event problem before it is an LLM problem.
- Specific fix: Use a broad liquid point-in-time universe. Create a two-stage funnel: cheap daily cross-sectional features (6–12m ex-1m relative strength, 1/3m acceleration, 20/50/200 trend, volume/traded-value, volatility, gap/ATR, distance from high, earnings surprise/revision where available, sector strength), then expensive research on at most three finalists. Add explicit liquidity/spread/price floors per market. Use setup-specific models (quality momentum, post-earnings drift, value inflection, ETF trend) and a separate fragility veto (extreme gap, crowding/social acceleration, low float where licensed, bearish high-volume reversal). Validate thresholds by liquidity bucket and market; do not let an LLM tune them directly.
- Required migration if any: Add PIT universe membership/liquidity snapshots and setup feature values if absent.
- Fail behavior: Missing liquidity or price history excludes a new entry; social/news absence reduces confidence but does not invent sentiment.
- Tests/verification: Historical event studies for MU/INTC/SNDK plus negative controls and meme reversals, with first-detection date, subsequent 5/10/20-day net return, MAE/MFE, turnover, and false-positive rate.
- Can a basic LLM fix this mechanically? no — it can implement an approved formula, not select/prove it.

### P1-4 — Make rank enforcement transactional and run-scoped before activating it
- Severity: MED
- Files: `app/api/agents/research/cron/route.ts`, `lib/scoring/rank.ts`
- Exact location: `app/api/agents/research/cron/route.ts:190-317`
- Confidence: [CONFIRMED]
- What is wrong: Pass 1 writes pending signals before Pass 2. Rank failures are logged “non-blocking,” so an active rank rule fails open. Rejection updates match symbol+market+status, not the exact signal/run, so concurrent pending rows can be changed. No-market legacy runs mix US/India but use the US champion/snapshot scope.
- Concrete failure scenario: Rank insert/update fails and PaperTrader consumes the still-pending signal; or a concurrent signal for the same symbol is marked rejected.
- Why this matters: A promoted selection rule must be the same deterministic gate in research, paper, validation, and live.
- Specific fix: Compute rank before publishing actionable status, or write candidates as `scored_pending_rank` and atomically publish/reject exact signal IDs after the full cohort completes. If rank is enabled and cohort/rank persistence fails, new entries remain non-actionable. Disallow unscoped mixed-market production runs.
- Required migration if any: Add status value/check constraint and unique run/symbol key if needed.
- Fail behavior: Enabled rank gate fails closed for new BUYs; held-position exit research continues.
- Tests/verification: concurrent runs, insert failure, mixed market, small/degraded group, exact signal IDs.
- Can a basic LLM fix this mechanically? yes after the state transition is approved.

### P1-5 — Make point-in-time fundamentals truly immutable and atomic
- Severity: MED
- Files: `lib/data/pit-fundamentals.ts`, `supabase/migrations/150_fundamental_facts.sql`
- Exact location: `lib/data/pit-fundamentals.ts:189-223,227-269`; migration 150 comments/schema
- Confidence: [CONFIRMED]
- What is wrong: The “append-only” archive updates prior rows' `is_latest`; flip and insert are separate best-effort operations; concurrent captures can create inconsistent latest flags. Normal callers pass neither report period nor filing date, so the archive usually knows only capture time. Read errors become empty fundamentals with no durable provider incident.
- Concrete failure scenario: Two workers capture the same symbol; both flip/insert, or flip succeeds and insert fails. Replay cannot know when pre-capture historical data was published.
- Why this matters: Point-in-time claims require a trustworthy knowledge timestamp.
- Specific fix: Never update vintage rows. Derive latest with a view/window query. Insert through one idempotent RPC with advisory lock and payload/source keys. Record `provider_published_at/filing_date` only from authoritative metadata; otherwise label `known_at=captured_at` and forbid use before capture. Surface capture/read failures in provider health.
- Required migration if any: Additive columns/unique indexes, immutable trigger, security-invoker view/RPC grants.
- Fail behavior: Capture failure never changes live score, but marks PIT provenance unavailable; replay abstains for dates before first known vintage.
- Tests/verification: concurrent identical/different restatements, failed insert, as-of boundary, missing filing date.
- Can a basic LLM fix this mechanically? yes after the data contract is approved.

### P1-6 — Make strategy lifecycle immutable and champion promotion atomic
- Severity: HIGH
- Files: `app/api/strategies/versions/route.ts`, strategy migrations
- Exact location: `app/api/strategies/versions/route.ts:43-116,119-137`
- Confidence: [CONFIRMED]
- What is wrong: Promotion demotes the old champion and then promotes the new one in two independent updates. If the second fails, there is no champion. Retire/reject/promotion rewrite `strategy_versions`, although the project invariant calls it append-only. GET is also unauthenticated.
- Concrete failure scenario: transient DB failure after demotion leaves research using legacy/fallback weights; historical rows no longer show their original lifecycle state.
- Why this matters: Strategy identity and approval history are safety evidence.
- Specific fix: Keep immutable version rows. Append lifecycle events (`created`, `validation_passed`, `promoted`, `retired`, `rejected`) and maintain a market-scoped champion pointer/projection in one SECURITY DEFINER RPC protected to service role and called by an owner-gated route. Lock per market and verify passed validation in the same transaction.
- Required migration if any: Additive lifecycle events/champion pointer/RPC; do not delete old versions.
- Fail behavior: Any check or write error leaves the old champion active.
- Tests/verification: concurrent promotions, second-write failure, invalid market, missing validation, immutable trigger.
- Can a basic LLM fix this mechanically? no — migration and compatibility plan need architecture review.

## P2 — should fix for reliability / maintainability

### P2-1 — Close unauthenticated service-role and provider-quota routes
- Severity: HIGH
- Files: `app/api/alerts/stale-check/route.ts`, `app/api/charts/symbol-history/route.ts`, `app/api/markets/quotes/route.ts`, options/calendar/market/chart GET routes listed by auth inventory
- Exact location: stale check `:77-166`; symbol history `:18-126`; market quotes `:1-76`
- Confidence: [CONFIRMED]
- What is wrong: Stale-check GET writes decision journal/alerts with service role and has no owner/cron gate. Symbol-history accepts arbitrary symbol/from/`refresh=1`, can make up to 20 provider pages, and upserts the cache with service role without auth. Numerous other market-data routes can spend paid/free quota anonymously.
- Specific fix: Require owner for dashboard reads and owner-or-cron for refresh/write operations. Separate cached read from refresh POST. Validate symbol/date ranges, cap candles/pages, use shared provider budgets, and add rate limiting.
- Fail behavior: Unauthorized 401/403 before provider or database access.
- Tests/verification: anonymous requests produce no provider fetch/write; bounded authenticated requests work.
- Can a basic LLM fix this mechanically? yes.

### P2-2 — Restore a green release gate
- Severity: MED
- Files: `tests/pit-fundamentals.test.ts`, `tests/technicals-scoring.test.ts`, relevant types
- Exact location: TypeScript errors at PIT test line 39 and technical scoring test line 5
- Confidence: [CONFIRMED]
- What is wrong: `npx tsc --noEmit` fails on an unsafe `FactRow` cast and an optional `atr14` incompatible with required `TechnicalResult`. Vitest passes 238 tests with 6 skipped. `http://localhost:3000/dashboard` returned HTTP 500; the in-app browser was blocked by the local browser client, so the UI cause was not observed.
- Specific fix: Correct test fixtures/types without weakening production types. Make build+typecheck+tests mandatory. Diagnose local 500 from the actual Next server log.
- Fail behavior: CI/deploy stops on type/build/test failure.
- Tests/verification: `npx tsc --noEmit`, `npm test -- --run`, `npm run build`, authenticated smoke test.
- Can a basic LLM fix this mechanically? yes.

### P2-3 — Fix research-run concurrency and calendars
- Severity: MED
- Files: `app/api/agents/research/cron/route.ts`, scheduling/calendar module
- Exact location: `app/api/agents/research/cron/route.ts:32-60,87-109,144-185`
- Confidence: [CONFIRMED]
- What is wrong: Idempotency is query-then-insert, so concurrent crons can both pass. US holidays are hardcoded “2026 approx”; India intentionally omits floating holidays. Provider concurrency defaults to five despite AV free-tier constraints.
- Specific fix: Acquire a DB advisory/unique run lease keyed by market+session+agent before work. Use the existing authoritative market-calendar provider/static annually verified exchange calendar. Allocate provider calls through the shared budget/cache queue rather than worker count alone.
- Fail behavior: Duplicate returns existing run; unknown market session prevents actionable signals but can run non-actionable research.
- Tests/verification: simultaneous POSTs, DST, half-day, NSE floating holiday, provider 429.
- Can a basic LLM fix this mechanically? yes after the lease schema is approved.

### P2-4 — Resolve remaining Supabase linter findings
- Severity: MED
- Files: new additive migrations
- Exact location: deployed Supabase advisors, 2026-07-11
- Confidence: [CONFIRMED]
- What is wrong: Supabase reports SECURITY DEFINER views `v_decision_quality` and `provider_budget_7d`, plus multiple functions with mutable search paths. Many internal tables have RLS enabled with no policy, which is acceptable denial-by-default only if service-role-only is deliberate. Default function privileges caused the v1 RPC exposure.
- Specific fix: Set views `security_invoker=true` or revoke anon/auth and use an internal schema. Set fixed safe search paths and schema-qualify objects in all definer functions. Explicitly revoke default function/table privileges and grant only required roles. Document service-only tables rather than adding permissive policies merely to silence INFO lint.
- Fail behavior: Browser roles cannot access internal views/functions; service role remains server-only.
- Tests/verification: Supabase security advisors, privilege matrix, anon/auth RPC calls.
- Can a basic LLM fix this mechanically? yes with reviewed SQL.

### P2-5 — Correct misleading exit and performance explanations
- Severity: MED
- Files: `app/api/agents/position-monitor/route.ts`, portfolio UI
- Exact location: `app/api/agents/position-monitor/route.ts:218-229`
- Confidence: [CONFIRMED]
- What is wrong: A position exited because direction was not long is journaled as `score_exit (score < threshold)`. Live data contains `TORNTPHARM.NS: score_exit (68 < 37)`, a mathematically false explanation. Portfolio totals also do not match trades/NAV.
- Specific fix: Persist structured reason codes and operands: `score_below_exit_threshold` versus `direction_flip`, including direction. UI must compute/display reconciled NAV and show stale/as-of timestamps.
- Fail behavior: Unknown reason displays “unavailable,” never a fabricated comparison.
- Tests/verification: neutral direction with score above threshold; score below threshold; exact journal text.
- Can a basic LLM fix this mechanically? yes.

## Architecture assessment

| Dimension | Score / 10 | Assessment |
|---|---:|---|
| Product/governance intent | 7.0 | Strong autonomy ladder and human-gated manual mode, but config/docs drift is dangerous. |
| Research/universe discovery | 4.0 | Multiple sources and US/India coverage exist; selection is narrow, static, and not PIT/liquidity disciplined enough. |
| Deterministic scoring | 5.0 | Better than LLM-supplied numbers; still fixed composite heuristics with limited cross-sectional/economic validation. |
| Learning/evolution | 2.0 | Good scaffolding, no operational evidence; Pearson nudging is not best-in-class optimization. |
| Paper/performance truth | 2.5 | Append-only events exist, but live portfolio projection is currently inconsistent. |
| Manual live execution | 5.0 | US gateway controls are promising; durability, kill-switch, and India parity defects remain. |
| Autonomous readiness | 2.5 | Correctly disabled, and should remain disabled. Evidence/promotion/exit requirements are not proven. |
| Data/provider resilience | 4.5 | Useful adapter/cache/budget layer, but several routes bypass it and observed dimensions are often missing. |
| Database/security | 5.0 | RLS/immutable work is substantial; exposed definer RPC/views and service-route gaps are material. |
| Observability/UX truth | 5.0 | Journal/health concepts are good; false/stale portfolio and explanation data undermine trust. |

Overall current capability: **4.2/10 versus a best-in-class, evidence-driven personal quant platform**. That is not a prediction of returns; it is a readiness score. The app is feature-rich but overbuilt ahead of trustworthy data and end-to-end evidence. Keep the deterministic gateway, evidence ledger, provider abstraction, and staged autonomy. Simplify agent responsibilities: one deterministic research pipeline, one statistical validation service, one execution/risk gateway, and LLMs only for hypothesis generation/explanation/coaching.

## Agent learning assessment

The current loop is not genuinely learning in production. It records observations, but has no matured labels and no model artifacts. LearnerAgent can propose immutable challengers, which is a good governance boundary, but its credit assignment remains univariate Pearson correlation and tiny samples. The typed genome is broader than five weights, yet most fields are not connected to a proven optimizer and rank/PIT/replay features are off.

Best practice for this scale is not a giant autonomous multi-agent swarm. It is:

1. A point-in-time dataset with immutable feature, availability, universe, price, cost, and corporate-action timestamps.
2. Setup-specific deterministic models trained by market/horizon with purged walk-forward folds and embargo.
3. Net-of-cost metrics: rank IC/ICIR, calibration, precision among top-k, turnover, MAE/MFE, drawdown, probability of improvement/deflated Sharpe.
4. Stable challenger promotion only after replay, shadow, paper, and small manual-live evidence.
5. LLMs propose new features and explain failure clusters; deterministic code computes weights, gates, and sizing.

Minimum roadmap: repair accounting and labels; make one setup (quality momentum) work end to end for US and India separately; establish prospective shadow evidence; only then add more archetypes or autonomous capital.

## Autonomy readiness assessment

Current effective level is manual live L3. `AUTONOMOUS_LIVE_ENABLED` is environment-gated and live DB autonomous toggles/modes are off/manual. That is correct. L4 should remain impossible until:

- All P0 defects and clean-DB replay tests pass.
- At least one strategy has sufficient PIT walk-forward + prospective shadow/paper evidence per market/setup.
- Manual-live fills verify slippage, broker reconciliation, partial fills, exits, and kill switches.
- Promotion is atomic, immutable, market/account/broker scoped, time-leased, and owner-approved.
- Autonomous sizing is deterministic: calibrated edge and volatility produce a desired size; owner ceilings clamp per-order, daily, position, sector, cash, liquidity, and drawdown. Unknown NAV/edge/quote/liquidity means size zero.

Variable sizing is appropriate, but the LLM should express conviction/evidence, not directly control dollars. A deterministic sizing kernel should map calibrated probability/expected return and risk to size, then clamp it.

## Live trading safety assessment

US Robinhood: account 605420660 is correctly hardcoded/allowlisted in the direct adapter path, and strict broker resolution avoids silent fallback. The unofficial direct REST path uses a token named for the MCP integration; its compatibility, scope, refresh behavior, and Robinhood terms are [SUSPECTED] until verified with official Robinhood documentation. Do not enable autonomous submission on an unsupported private endpoint.

India Kite: not parity-safe because the route is separate and no active account is configured. It must use the same canonical proposal, account identity, budget, drift, holdings, portfolio, durable event, and reconciliation services.

Daily budget: atomic concept is good. v1 grant exposure and v2 UTC-session math must be fixed. Rate-limit counting outside the RPC is TOCTOU and should be advisory or moved into the same reservation transaction.

Exits: protective exits exist for both markets, but they are coupled to autonomous enablement and blocked by kill switches/security states in ways that can freeze risk reduction. Exit policy also uses hardcoded 8%/20%/15 days rather than the originating approved strategy/position plan.

## Supabase / schema / RLS assessment

Live DB access was real and exposed several doc/schema mismatches (`paper_trades.created_at` and `paper_portfolio.open_positions` do not exist). Migration versions through timestamp `20260711050533` are applied. RLS is widespread, but service-role routes and definer objects remain the key boundary. The most urgent database fix is v1 RPC grants; then security-invoker views/fixed search paths/default privileges. Empty-policy service-only tables are not automatically bugs: denial-by-default is appropriate if all access is server-side and documented.

Append-only design is inconsistent. `decision_observations` and order-event ledgers are treated correctly, but `strategy_versions` is mutated for lifecycle and `fundamental_facts` updates `is_latest`. Use append-only lifecycle/vintage events and projections instead.

## Data provider assessment

| Provider | Used by | Data dimensions | Free/paid/unknown | Rate-limit handling | Reliability risk | Recommended action |
|---|---|---|---|---|---|---|
| Alpha Vantage | Research, options, corporate actions, theme, trader calendar | quotes, daily, news, insider, options, dividends/splits/earnings | Configured as 25/day free | Shared cache/budget in some paths; several direct routes bypass it | High quota fragmentation; uneven India support | Route every call through provider layer; reserve for unique corporate/news data |
| Massive | Quotes, candles, breadth, briefings, charts | US price/volume/reference | Tier unknown | Cache exists; anonymous routes can force many calls | Quota abuse and prev-day data mistaken for live | Owner-gate refresh, central budget, explicit as-of/staleness |
| FinancialDatasets | US screen/fundamentals | fundamentals/screener | Unknown | Direct calls, timeout, silent empty fallback | Screener default coverage/order and entitlement uncertainty | Keep only if tier supports daily universe; log provider rejection/coverage |
| FMP | Fundamentals/candles/news fallback | fundamentals, prices, news | Code assumes ~250/day free | Shared budget/cache | API plan/endpoint changes; field mapping | Use as fallback with schema validation and provenance |
| Finnhub | Earnings/analyst | calendar/consensus | Likely free key; exact tier unknown | Limited explicit budget evidence | Free-tier limits/staleness | Cache daily; advisory only until coverage measured |
| FRED | MacroSentinel | official macro series | Free | Daily cache | Revision/look-ahead without ALFRED vintages | Use ALFRED/vintage dates for replay; current FRED for live context |
| Yahoo | India fundamentals/quotes/options fallback | India price/fundamental/calendar | Unofficial/free | Partial caching | Schema/availability changes, no SLA | Keep as degraded fallback; Upstox/Kite for authoritative India prices |
| Upstox | India instruments/candles/LTP | India market data | Token/free/unknown | Shared budget/cache | Token lifecycle and source mixing | Prefer for India research if entitlement permits; validate exchange/instrument IDs |
| Robinhood MCP/direct REST | US accounts/orders/quotes | broker state and execution | Account feature | Token refresh and adapter checks | Direct private REST support is unverified | Use official MCP methods for supported operations; deterministic adapter only |
| Kite/Zerodha | India account/orders/holdings | broker state and execution | Paid Kite Connect likely | Daily token handling | Wrong-account path and token expiry | Bind user ID/account allowlist; shared execution gateway |
| StockTwits | Sentiment | social | Free/public behavior unknown | Bayesian shrinkage added | Manipulation, sparse coverage | Advisory/fragility feature only; never strong standalone weight |
| Jina | RAG embeddings/rerank | semantic memory | Free tier | Env-gated | Live corpus currently empty | Keep optional; do not market RAG as learning until corpus exists |
| DeepSeek/Groq | Agents/explanations | text reasoning | Paid/free tiers unknown | Router/fallback/health | LLM hallucination/prompt injection | Use for hypotheses/explanations, never prices, limits, approvals, or numeric optimizer |
| TradingView paid UI | Manual validation | charts/technical/fundamental views | User paid membership | No official app API | Scraping/ToS and brittle automation | Use manual deep links/imports/alerts only; do not scrape authenticated UI |

Missing/weak dimensions for serious swing selection remain: PIT earnings revisions/surprises, PIT universe membership, reliable US/India liquidity/spread/float, India corporate-action calendars, borrow/crowding proxies (advisory), and total-return/corporate-action-adjusted labels.

## US pipeline assessment

Discovery → research → signal → paper exists, but discovery is biased toward watchlist plus a six-name fundamentals screen. Cross-sectional rank, PIT fundamentals, and replay are present but off or empty. Signals are deterministic and LLM-advisory scores are excluded, which is good. Paper accounting is not trustworthy today. Learning has no matured labels. Manual live US has strict broker/account resolution, fresh quote, caps, G1/G3, holdings check, and atomic reservation, but kill-switch/durability/RPC issues block a safe verdict. Autonomous mode is correctly off.

## India pipeline assessment

India has nightly cache candidates, Yahoo/Upstox/Kite data, paper positions, and protective-exit code. However, discovery thresholds lack explicit liquidity/size/spread constraints at final selection, fallback to static Nifty names hides cache failure, macro/fundamental coverage can be sparse, and the live order path is not account-scoped through the canonical gateway. India config is live-enabled with no active account, so it must be disabled until account binding and shared gateway parity are proven.

## Frontend / user-experience assessment

Runtime UI could not be fully exercised: the in-app browser blocked localhost and direct localhost returned HTTP 500. Code review and DB show user-facing truth risks that must be fixed first: stale/inconsistent paper NAV/totals; mathematically false exit explanation; settings/config copy likely assumes paper-only while live flags are true; learning pages can imply capability despite zero labels/artifacts/shadows. Every performance card should show market, currency, source, as-of time, reconciled status, and an “insufficient evidence” state. Dangerous live controls should show exact broker/account/market/caps and require typed confirmation.

## Security assessment

Positive: owner gates exist on the canonical live US route; broker resolution is strict; autonomous deployment flag is external; LLM actors cannot pass risk overrides; Robinhood primary read-only account is not the order account.

Material issues: exposed v1 SECURITY DEFINER RPC; unauthenticated service-role/provider routes; security-definer views; mutable search paths; strategy GET exposure; direct Robinhood REST uncertainty. External LLM/news/social inputs must be treated as untrusted text and must never set symbols, prices, account IDs, limits, or tool arguments without deterministic allowlists/schema validation.

## Reliability / operations assessment

Vitest: 238 passed, 6 skipped. Typecheck fails. Localhost dashboard returned 500. Research run lease is non-atomic. Several database/provider failures are swallowed, including money/performance projections. Direct API calls bypass provider budgets. OneDrive/worktree noise and 43 changes to `lib/research-agent.ts` plus 34 to PaperTrader in a short history show hotspot/bus-factor risk: almost all 292 commits come from one author identity. Break oversized routes into pure domain services and enforce contract/integration tests.

## Better architecture recommendations

### Multi-agent architecture
- Current design: Many named routes/agents with overlapping research, explanation, coaching, and operational roles.
- Verdict: refactor
- Why: Complexity exceeds evidence volume; “agents” often wrap scheduled functions and disconnected tables.
- Better design: Four bounded services: Data/Feature Pipeline; Statistical Research & Validation; Portfolio/Risk/Execution; Explanation/Coach. LLMs live only in hypothesis/explanation layer.
- Migration path: Keep routes as facades; move deterministic logic into versioned pure services and shared contracts.
- Files likely affected: `app/api/agents/*`, `lib/research-agent.ts`, `lib/agents/*`.
- Acceptance criteria: One trace ID links universe snapshot → features → score → decision → proposal → fill → label; no duplicated scoring/order logic.
- Priority: P1

### Universe discovery and scoring
- Current design: Watchlist + small dual-bucket screens → fixed five-dimension composite → optional rank.
- Verdict: refactor
- Why: Weak early-inflection recall and inconsistent comparable groups.
- Better design: Broad PIT liquid universe, cheap feature rank, setup router, top-three deep research, calibrated top-k probability/utility.
- Migration path: Run new funnel shadow-only alongside current deterministic_v1; compare first-detection and net outcomes.
- Files likely affected: research agent, screeners, rank, observation schema.
- Acceptance criteria: Historical and prospective precision/recall, turnover, cost, MAE/MFE by market/setup; no survivorship leakage.
- Priority: P1

### Learning/evolution
- Current design: Pearson diagnostic can create weight challenger; calibration/replay/genome scaffolding largely inactive.
- Verdict: replace optimizer, keep governance/evidence tables
- Why: Credit assignment is statistically unsound and no evidence flows today.
- Better design: Regularized setup-specific model + nested purged walk-forward + shadow champion/challenger; LLM feature proposals only.
- Migration path: Disable numeric Pearson mutations; operationalize labels/replay; validate one setup first.
- Files likely affected: learner, validation, dataset, genome, strategy lifecycle.
- Acceptance criteria: Stable OOS improvement net costs; reproducible dataset/model hashes; prospective confirmation.
- Priority: P1

### Live execution/risk
- Current design: Strong shared US service plus separate Kite route and mixed paper/live kill-switch API.
- Verdict: refactor
- Why: A safety invariant must have one implementation.
- Better design: One canonical execution command with explicit actor, market, broker, account, currency, intent (increase/reduce risk), strategy version, idempotency key; one transactional reservation/event path.
- Migration path: Adapt Kite route to the service; split paper/live risk; preserve current manual API contract.
- Files likely affected: execute-order, broker adapters, Kite route, kill switches, RPC.
- Acceptance criteria: Same test matrix for US/India; exact-account held SELL; ambiguous submit never retried; kill blocks increase but permits verified decrease.
- Priority: P0

### Supabase architecture
- Current design: Public-schema tables/functions with broad service-role usage, RLS, and many additive migrations.
- Verdict: patch/refactor boundary
- Why: Definer/grant drift repeats; public schema is too broad.
- Better design: Internal/private schema for ledgers/functions; small `api` schema for explicit browser RPC/views; security-invoker views; explicit grants; append-only events + projections.
- Migration path: Revoke first, then introduce API views/RPCs without moving tables wholesale.
- Files likely affected: migrations and Supabase clients.
- Acceptance criteria: privilege matrix test and clean security advisors for ERROR/WARN findings.
- Priority: P0/P2

### Provider/caching architecture
- Current design: Shared provider layer plus many direct-fetch exceptions.
- Verdict: refactor
- Why: Quota and staleness policy are not universal.
- Better design: Every provider request goes through one budget/cache/provenance API returning `{data,status,source,asOf,stale,quota}`.
- Migration path: Wrap direct routes one provider at a time; forbid raw provider URLs via lint/grep test outside adapters.
- Files likely affected: data libs and chart/market/agent routes.
- Acceptance criteria: No unauthenticated quota use; missing data creates explicit unavailable dimension; cost dashboard matches calls.
- Priority: P1/P2

## Fix roadmap

### Phase 0 — stop live-money risk (checklist)
- [ ] Owner disables current live flags until acceptance passes.
- [ ] Split paper/live kill-switch API; add fresh account-scoped baseline; permit verified risk-reducing SELLs.
- [ ] Route Kite through shared execution and bind exact account identity.
- [ ] Persist broker acknowledgment/event before returning success.
- [ ] Revoke v1 RPC from PUBLIC/anon/auth; fix v2 market day/currency/account lock.
- [ ] Repair PositionMonitor NAV update and reconcile existing paper projections.
- [ ] Add failure-injection and clean-DB integration tests.

### Phase 1 — make recommendations trustworthy (checklist)
- [ ] Central provider contract and auth/rate limits for every route.
- [ ] PIT liquid universes and setup-specific feature funnel for US/India.
- [ ] Rank state transition becomes exact-ID, transactional, and fail-closed when enabled.
- [ ] PIT fundamentals become immutable/atomic.
- [ ] UI shows reconciled/as-of/evidence readiness rather than capability claims.

### Phase 2 — make learning real (checklist)
- [ ] Mature horizon-aligned benchmark-neutral labels daily.
- [ ] Replace Pearson optimizer with regularized/nested walk-forward pipeline.
- [ ] Run historical replay only on knowable inputs; record dataset/model hashes.
- [ ] Shadow champion/challenger by market/setup; require stability and net-of-cost gains.
- [ ] Make lifecycle events immutable and promotion atomic.

### Phase 3 — enable bounded autonomous trading (checklist)
- [ ] Accumulate prospective paper/shadow and manual-live evidence.
- [ ] Verify fills, slippage, partial fills, cancel/reconcile, exits, and kill switches in canary.
- [ ] Owner promotes one strategy/account/broker/market into a short L4 lease.
- [ ] Start with tiny deterministic caps and automatic expiry; no LLM overrides.
- [ ] Roll back to L3 on any reconciliation/data-quality/health uncertainty.

### Phase 4 — scale quality and automation (checklist)
- [ ] Expand only setups with proven incremental edge.
- [ ] Add regime-conditioned scaling, not brittle hard bull/bear switching.
- [ ] Monitor drift/calibration/cost/capacity and retire deteriorating strategies.
- [ ] Add annual exchange calendar/provider entitlement reviews.

## Mechanical fix list for Claude / basic LLM

| # | Priority | File(s) | Exact change | Acceptance test |
|---|---|---|---|---|
| 1 | P0 | `lib/kill-switches.ts` + callers | Add explicit `book/accountId`; validate snapshot age; remove `live_auto_enabled` inference | manual live never queries paper tables |
| 2 | P0 | `execute-order.ts` | Apply kill block to BUY/risk increase; allow exact-account held SELL | tripped switch rejects BUY, accepts held SELL |
| 3 | P0 | Kite route/adapter | Delegate to shared service; require active+allowlisted Kite user ID | null/wrong account never submits |
| 4 | P0 | `execute-order.ts` | Check event/projection writes after broker ACK; return reconcile on failure | injected DB failure returns 202, no resubmit |
| 5 | P0 | PositionMonitor | Remove/add missing `open_positions`; check update error; invariant audit | NAV=cash+positions for both markets |
| 6 | P0 | migration 152+ | Revoke v1 from PUBLIC/anon/auth; fix v2 local date/currency/account lock | privilege and boundary-time SQL tests |
| 7 | P0 | config/runbook | Owner disables live flags until P0 tests pass | all live routes 403, paper works |
| 8 | P1 | strategy route+migration | Atomic lifecycle event/pointer RPC; owner-gate GET | failed promotion leaves old champion |
| 9 | P1 | learner/validation | Pearson diagnostic-only; deterministic OOS optimizer | null/outlier data cannot promote |
| 10 | P1 | research/rank | publish actionable signal only after exact-ID rank pass | rank persistence failure leaves non-actionable |
| 11 | P1 | PIT fundamentals | append only, atomic insert, derived latest, known-at semantics | concurrent/as-of tests pass |
| 12 | P1 | screeners | add PIT liquidity/size/spread and setup features | illiquid names excluded; event-study report |
| 13 | P2 | API routes | owner/cron gate writes and quota routes; bound query ranges | anonymous request makes zero external calls |
| 14 | P2 | migrations | security-invoker views, fixed search paths, explicit default grants | Supabase security advisor errors resolved |
| 15 | P2 | tests/types | fix two type errors; diagnose localhost 500 | tsc, tests, build, smoke all green |
| 16 | P2 | research cron | transactional per-market/session run lease and verified calendars | concurrent trigger produces one run |
| 17 | P2 | PositionMonitor/journal | structured exit reason and correct text | never emits `68 < 37` when exit was direction flip |

## Clean sections

- [CONFIRMED] Autonomous entries are currently disabled by both deployment/database controls; live modes are manual and DB auto toggle is false.
- [CONFIRMED] Canonical US order resolution does not silently fall back to another broker.
- [CONFIRMED] Robinhood order account constant is 605420660; the primary/read-only 965848641 is not the order account in reviewed adapters.
- [CONFIRMED] New-position long-only and exact-held-quantity SELL checks exist in the shared gateway.
- [CONFIRMED] Owner-only risk overrides require a durable reason and autonomous workers cannot send them.
- [CONFIRMED] v2 budget RPC is restricted to postgres/service_role in live DB.
- [CONFIRMED] Unit suite is broad and currently green: 238 passed, 6 skipped.
- [CONFIRMED] Rank, PIT fundamentals, and historical replay upgrades are off/default-non-actionable, so their defects do not currently change live selection.

## Review limitations

Supabase access method: `mcp__codex_apps__supabase_execute_sql` against project `dionkikgdmlaotvtbnfr` (`FinanceOS`), SELECT-only.

STEP 0 raw results:

```text
QUERY 1 (as written in prompt):
select count(*) as trades, max(created_at) as latest from paper_trades;
ERROR 42703: column "created_at" does not exist

Schema inspection showed the actual timestamp is executed_at.
Corrected read-only query:
select count(*) as trades, max(executed_at) as latest from paper_trades;
[{"trades":11,"latest":"2026-07-09 14:18:59.30081+00"}]

QUERY 2:
select version from supabase_migrations.schema_migrations order by version desc limit 8;
[{"version":"20260711050533"},{"version":"20260711050517"},{"version":"20260711050501"},{"version":"20260711033651"},{"version":"20260711032355"},{"version":"20260711023255"},{"version":"20260711003243"},{"version":"20260710234815"}]

QUERY 3:
select count(*) from trade_memories;
[{"count":0}]
```

Additional verified live facts: applied migrations use timestamp versions, not bare 118/119/120; the corresponding tables exist. The prompt's “paper-only/trading disabled” assumption is stale. No database writes were made.

Runtime limitations: the in-app browser refused localhost with `ERR_BLOCKED_BY_CLIENT`; direct `http://localhost:3000/dashboard` returned HTTP 500 with no attached server log, so full visual/click-through QA was not possible. Broker/provider dashboards, real OAuth scopes, actual order submission, and paid tier entitlements were not tested. Direct Robinhood REST compatibility/terms are therefore [SUSPECTED], not confirmed. `npm run build` was not treated as meaningful after `tsc --noEmit` failed; Vitest did complete successfully.
