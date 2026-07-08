# 07/08 Full App Review — Kairos / FinanceOS

## Executive verdict

- Is the app safe for live money now? **Not yet.** The main live order gateways are much stronger than before, but several service-role API routes still expose or mutate sensitive data without owner/cron gates, and two safety migrations are not reproducible from the committed SQL files.
- Is it architecturally coherent? **Partially.** The intended pipeline is coherent: research → evidence ledger → paper trading → learning → challenger strategy → validation/promotion → live gateway. The implementation is uneven across older routes, imported trade/RAG flows, and dashboard APIs.
- Is the agent learning loop genuinely effective yet? **No.** It has useful infrastructure, but current learning is still closer to evidence-assisted reweighting than a statistically reliable self-evolving quant system.
- Is the path to autonomous trading correctly designed? **Conceptually yes, not implemented yet.** The right goal is bounded autonomous trading after evidence. The app still needs a durable autonomy state machine, strategy/account-level promotion gates, clean reconciliation, and stronger validation.
- Top 5 blockers:
  1. Service-role API routes without owner/cron auth.
  2. Comment-only migrations for safety fixes.
  3. Live override audit writes can fail silently.
  4. Non-owner authenticated users can mutate some learning/config controls.
  5. Learning/evolution is not statistically strong enough for autonomous live trading.

## Risk ranking summary

| Rank | Severity | Area | Issue | Money-loss / product risk | Fix owner |
|---|---|---|---|---|---|
| 1 | CRITICAL | Security / live data | Live portfolio routes expose account snapshots/holdings without auth | Sensitive live financial data can leak | Builder |
| 2 | CRITICAL | Security / trade history | Imported trade files/decisions can be deleted without auth | Learning/RAG history can be erased or poisoned | Builder |
| 3 | HIGH | Schema / migrations | Migrations 111 and 112 are comment-only | Fresh deploys miss live-money safety fixes | Architect + Builder |
| 4 | HIGH | Live governance | Override audit writes are best-effort | A live-risk bypass can proceed without durable audit | Builder |
| 5 | HIGH | Authz | Authenticated non-owner can mutate agent/learner/pause/paper-close routes | Config/learning state can be changed outside owner authority | Builder |
| 6 | HIGH | RAG/evidence | `doc_chunks` reingestion deletes before successful replacement | Evidence memory can be wiped on failure | Builder |
| 7 | MED | Learning | Learner still relies on univariate correlation for weight proposals | False credit assignment / overfitting | Architect |
| 8 | MED | Strategy governance | `force_unvalidated:true` can promote a champion | Validation gate can be bypassed too casually | Architect |
| 9 | MED | Provider architecture | Some expensive provider calls bypass the unified budget/cache layer | Free tiers can be exhausted outside the intended control plane | Builder |
| 10 | MED | Admin/security | Admin LLM cost/log APIs lack route auth | Model/cost/prompt-adjacent metadata can leak | Builder |
| 11 | LOW | Provider config | EODHD default budget assumes paid tier | Capacity dashboard can overstate free-tier capacity | Builder |

## P0 — must fix before live trading or autonomous mode

### P0-1 — Service-role live portfolio routes are not owner-gated

- Severity: CRITICAL
- Files:
  - `app/api/live-portfolio/route.ts`
  - `app/api/live-portfolio/performance/route.ts`
- Exact location:
  - `app/api/live-portfolio/route.ts:7-13`
  - `app/api/live-portfolio/route.ts:75`
  - `app/api/live-portfolio/performance/route.ts:39-47`
- Confidence: [CONFIRMED]
- What is wrong: These routes use `createServiceClient()` and return `live_account_snapshots` / positions without `requireOwner()` or cron auth.
- Concrete failure scenario: Anonymous caller requests `/api/live-portfolio` and receives account IDs, positions, equity/buying power snapshots, and merged holdings.
- Why this matters: This leaks live financial data and weakens the broker/account separation model.
- Specific fix: Add `requireOwner()` to all live-portfolio read routes that return account/position/financial data. If a route is internal cron-only, require `verifyCronSecret()`.
- Required migration if any: None.
- Fail behavior: Unauthenticated returns 401; authenticated non-owner returns 403.
- Tests/verification: Anonymous `GET /api/live-portfolio` returns 401; owner session still returns holdings.
- Can a basic LLM fix this mechanically? yes.

### P0-2 — Imported trade decisions/files can be read and deleted without auth

- Severity: CRITICAL
- Files:
  - `app/api/live-portfolio/decisions/route.ts`
  - `app/api/live-portfolio/files/route.ts`
- Exact location:
  - `app/api/live-portfolio/decisions/route.ts:6-24`
  - `app/api/live-portfolio/decisions/route.ts:27-32`
  - `app/api/live-portfolio/files/route.ts:6-12`
  - `app/api/live-portfolio/files/route.ts:15-31`
- Confidence: [CONFIRMED]
- What is wrong: Routes use service role and expose/delete `trade_decisions` / `uploaded_trade_files` without any owner gate.
- Concrete failure scenario: Anonymous caller sends `DELETE /api/live-portfolio/files?id=<id>` and deletes imported files plus related trade decisions.
- Why this matters: Imported trade history feeds behavioral learning, mentor review, semantic search, and RAG. Deleting it destroys audit context.
- Specific fix: Add `requireOwner()` to GET and DELETE. Prefer soft-delete/audit over hard delete: `deleted_at`, `deleted_reason`, `deleted_by`, and filter queries by `deleted_at is null`.
- Required migration if any: Additive soft-delete columns if implementing audit-preserving delete.
- Fail behavior: If auth or audit write fails, no delete occurs.
- Tests/verification: Anonymous DELETE returns 401; owner delete writes audit/soft-delete.
- Can a basic LLM fix this mechanically? Auth gate yes; soft-delete requires a small migration.

### P0-3 — Safety migrations 111 and 112 are not reproducible

- Severity: HIGH
- Files:
  - `supabase/migrations/111_reserve_budget_market_day_and_failed.sql`
  - `supabase/migrations/112_v_decision_quality_guarded_casts.sql`
  - `supabase/migrations/105_daily_live_budget.sql`
  - `supabase/migrations/104_v_decision_quality.sql`
- Exact location:
  - `supabase/migrations/111_reserve_budget_market_day_and_failed.sql:1-6`
  - `supabase/migrations/112_v_decision_quality_guarded_casts.sql:1-5`
  - `supabase/migrations/105_daily_live_budget.sql:57-68`
  - `supabase/migrations/104_v_decision_quality.sql:41-46`
- Confidence: [CONFIRMED]
- What is wrong: Migrations 111/112 state fixes were applied via MCP, but contain no executable SQL. A fresh database replaying repo migrations gets the older daily-budget and `v_decision_quality` behavior.
- Concrete failure scenario: Fresh deploy uses UTC day windows, does not exclude `failed`/`expired` from live budget, and may throw on malformed JSON casts in `v_decision_quality`.
- Why this matters: Live-money safety depends on schema being reproducible from repo migrations.
- Specific fix: Add new executable migrations, e.g. `121_reserve_budget_market_day_and_failed_function.sql` and `122_v_decision_quality_guarded_casts_view.sql`, containing the full function/view definitions. Do not rely on comments that say “applied via MCP.”
- Required migration if any: Yes, additive/replacement `create or replace function/view` migrations.
- Fail behavior: Fresh database must fail closed with latest function/view behavior.
- Tests/verification: Fresh DB migration replay; assert `reserve_live_order_budget` latest signature/body exists and malformed quality JSON returns `quality_status='unknown'`.
- Can a basic LLM fix this mechanically? yes if provided the intended SQL.

### P0-4 — Live-risk overrides can proceed even if audit insert fails

- Severity: HIGH
- Files:
  - `app/api/broker/orders/route.ts`
  - `app/api/kite/order/route.ts`
- Exact location:
  - `app/api/broker/orders/route.ts:100-112`
  - `app/api/kite/order/route.ts:133-140`
  - `app/api/kite/order/route.ts:160-166`
- Confidence: [CONFIRMED]
- What is wrong: Override reason is required, but `decision_journal.insert()` errors are swallowed via `.then(() => {}, () => {})`.
- Concrete failure scenario: DB insert fails, but `acceptLowQuality`, `acceptPortfolioRisk`, or `manualOverride` still bypasses G1/G3 and proceeds toward broker submit.
- Why this matters: An override is only safe if it is durable and reviewable.
- Specific fix: Await insert, check `error`, and return 500 before budget reservation/broker submit if the audit row is not written.
- Required migration if any: None.
- Fail behavior: Override fails closed if audit cannot be persisted.
- Tests/verification: Mock insert error and assert broker submit is not called.
- Can a basic LLM fix this mechanically? yes.

### P0-5 — Config/learning/paper mutation routes are authenticated-only, not owner-only

- Severity: HIGH
- Files:
  - `app/api/agents/agent-config/route.ts`
  - `app/api/agents/learner-controls/route.ts`
  - `app/api/settings/pause/route.ts`
  - `app/api/paper-positions/close/route.ts`
- Exact location:
  - `app/api/agents/agent-config/route.ts:14-40`
  - `app/api/agents/learner-controls/route.ts:16-95`
  - `app/api/settings/pause/route.ts:17-37`
  - `app/api/paper-positions/close/route.ts:14-91`
- Confidence: [CONFIRMED]
- What is wrong: These routes only check for an authenticated user. They should call `requireOwner()` because they mutate model config, learner config/weights, app pause, or paper ledger state.
- Concrete failure scenario: A non-owner authenticated session can update model assignments, roll back weights, pause/unpause the app, or close paper positions if middleware assumptions change or are bypassed.
- Why this matters: Money/config/learning controls must be owner-gated.
- Specific fix: Replace raw auth checks with `requireOwner()` on all mutating routes.
- Required migration if any: None.
- Fail behavior: Non-owner returns 403.
- Tests/verification: Authenticated non-owner PATCH/POST returns 403.
- Can a basic LLM fix this mechanically? yes.

## P1 — must fix before trusting agent recommendations

### P1-1 — RAG document ingestion deletes old chunks before successful replacement

- Severity: HIGH
- Files:
  - `lib/rag/ingest.ts`
  - `supabase/migrations/120_doc_chunks_ingestion.sql`
- Exact location:
  - `lib/rag/ingest.ts:88-93`
  - `lib/rag/ingest.ts:129-147`
  - `supabase/migrations/120_doc_chunks_ingestion.sql:8-21`
- Confidence: [CONFIRMED]
- What is wrong: `ingestDocument()` deletes existing chunks for a source before inserting replacements.
- Concrete failure scenario: Re-ingest starts, old chunks are deleted, insert fails due vector/schema/provider issue, and the document disappears from retrieval.
- Why this matters: Evidence memory should be durable and auditable.
- Specific fix: Add versioned chunks: insert new `ingest_version` rows first, then mark old version inactive after successful insert. Or use a staging table + transactional swap RPC.
- Required migration if any: Additive `doc_chunks.ingest_version`, `doc_chunks.active`, indexes.
- Fail behavior: Failed reingest preserves existing active chunks.
- Tests/verification: Forced insert failure leaves old active chunks retrievable.
- Can a basic LLM fix this mechanically? partly; needs careful schema/query update.

### P1-2 — Imported trade enrichment POST is not owner/cron gated

- Severity: HIGH
- Files:
  - `app/api/live-portfolio/enrich/route.ts`
- Exact location:
  - `app/api/live-portfolio/enrich/route.ts:66-79`
  - `app/api/live-portfolio/enrich/route.ts:108-114`
- Confidence: [CONFIRMED]
- What is wrong: POST mutates `trade_decisions` and burns Alpha Vantage without owner/cron auth.
- Concrete failure scenario: Anonymous caller repeatedly triggers enrichment and updates imported trade rows.
- Why this matters: Provider budget and learning/RAG inputs can be affected externally.
- Specific fix: Require `requireOwner()` or `verifyCronSecret()` before DB/provider work.
- Required migration if any: None.
- Fail behavior: Unauthorized returns 401/403.
- Tests/verification: Anonymous POST returns 401.
- Can a basic LLM fix this mechanically? yes.

### P1-3 — Alerts can be created/resolved without auth

- Severity: HIGH
- Files:
  - `app/api/alerts/route.ts`
- Exact location:
  - `app/api/alerts/route.ts:6-16`
  - `app/api/alerts/route.ts:19-30`
  - `app/api/alerts/route.ts:33-44`
- Confidence: [CONFIRMED]
- What is wrong: Anyone can read alerts, insert alerts, or resolve all alerts using service role.
- Concrete failure scenario: Anonymous caller resolves all open safety alerts or inserts fake critical alerts.
- Why this matters: Alert integrity is part of trading safety.
- Specific fix: GET/PATCH owner-only. Remove public POST or make it internal-only through a server helper/cron-secret path.
- Required migration if any: None.
- Fail behavior: Unauthorized returns 401/403.
- Tests/verification: Anonymous POST/PATCH returns 401.
- Can a basic LLM fix this mechanically? yes.

### P1-4 — Strategy promotion has an easy force-unvalidated bypass

- Severity: MED
- Files:
  - `app/api/strategies/versions/route.ts`
- Exact location:
  - `app/api/strategies/versions/route.ts:54-89`
- Confidence: [CONFIRMED]
- What is wrong: `force_unvalidated:true` can promote a challenger without passed validation. It is journaled, but too easy to use in the normal promote action.
- Concrete failure scenario: UI or weak LLM sends the flag and an unvalidated strategy becomes champion.
- Why this matters: Champion strategy affects ResearchAgent scoring and future trading eligibility.
- Specific fix: Split into a separate governance override endpoint requiring explicit reason and warning. For any autonomy-eligible strategy, disallow unvalidated promotion entirely.
- Required migration if any: Optional additive governance fields on `strategy_versions`.
- Fail behavior: Normal promotion returns 412 without passed validation.
- Tests/verification: `promote_champion` without validation returns 412 unless explicit override path is used.
- Can a basic LLM fix this mechanically? yes with exact API contract.

### P1-5 — Learner is not yet a robust optimizer

- Severity: MED
- Files:
  - `app/api/agents/learner/route.ts`
- Exact location:
  - `app/api/agents/learner/route.ts:251-303`
  - `app/api/agents/learner/route.ts:417-515`
  - `app/api/agents/learner/route.ts:764-770`
- Confidence: [CONFIRMED]
- What is wrong: The current server-side evidence binding is good, but the actual credit assignment remains mostly univariate correlation and narrow weight changes.
- Concrete failure scenario: A dimension correlates during one regime, weight rises, and then hurts in a different regime/horizon because interactions and benchmark effects were not validated.
- Why this matters: This blocks “world-class self-evolving quant agent” claims.
- Specific fix: LLM proposes hypotheses/features. Deterministic optimizer performs walk-forward validation, benchmark-neutral labels, market/horizon cohorts, regularization, and shadow A/B before promotion.
- Required migration if any: likely additive extensions to `validation_experiments` / strategy genome tables.
- Fail behavior: Learner can create draft/challenger proposals only; no champion/autonomy promotion without passed validation.
- Tests/verification: Challenger cannot promote without `validation_experiments.passed=true`.
- Can a basic LLM fix this mechanically? no; architecture work.

## P2 — should fix for reliability / maintainability

### P2-1 — G3 portfolio gate contract makes skipped risk look like ok

- Severity: MED
- Files:
  - `lib/risk/live-portfolio-gate.ts`
  - `app/api/broker/orders/route.ts`
  - `app/api/kite/order/route.ts`
- Exact location:
  - `lib/risk/live-portfolio-gate.ts:20-23`
  - `lib/risk/live-portfolio-gate.ts:49-50`
  - `lib/risk/live-portfolio-gate.ts:125-130`
  - `lib/risk/live-portfolio-gate.ts:153-155`
  - `app/api/broker/orders/route.ts:230-238`
  - `app/api/kite/order/route.ts:145-166`
- Confidence: [CONFIRMED]
- What is wrong: The library returns `{ok:true, skipped:true}`. Current callers block skipped, but the contract is fragile.
- Concrete failure scenario: Future caller checks only `if (!pg.ok)` and accidentally fail-opens unknown portfolio risk.
- Why this matters: Unknown portfolio risk should require override, not look successful.
- Specific fix: Use discriminated union: `pass | block | requires_override`.
- Required migration if any: None.
- Fail behavior: Stale/unknown portfolio book requires override.
- Tests/verification: Unit test stale NAV returns `requires_override`.
- Can a basic LLM fix this mechanically? yes.

### P2-2 — Admin LLM cost/log APIs lack route auth

- Severity: MED
- Files:
  - `app/api/admin/llm-costs/route.ts`
  - `app/api/admin/llm-log/route.ts`
- Exact location:
  - `app/api/admin/llm-costs/route.ts:6-79`
  - `app/api/admin/llm-log/route.ts:8-42`
- Confidence: [CONFIRMED]
- What is wrong: They use service role and return LLM usage/cost logs without admin/owner auth.
- Concrete failure scenario: Anonymous caller reads model usage, cost history, and potentially prompt-adjacent metadata.
- Why this matters: Operational data leaks.
- Specific fix: Add `requireOwner()` or shared admin API guard.
- Required migration if any: None.
- Fail behavior: Unauthorized returns 401/403.
- Tests/verification: Anonymous GET returns 401.
- Can a basic LLM fix this mechanically? yes.

### P2-3 — Provider abstraction is not universal

- Severity: MED
- Files:
  - `app/api/agents/research/scan/route.ts`
  - `app/api/live-portfolio/enrich/route.ts`
  - `app/api/live-portfolio/performance/route.ts`
  - `lib/data/provider-fetch.ts`
- Exact location:
  - `app/api/agents/research/scan/route.ts:33-47`
  - `app/api/live-portfolio/enrich/route.ts:49-64`
  - `app/api/live-portfolio/performance/route.ts:21-36`
  - `lib/data/provider-fetch.ts:77-141`
- Confidence: [CONFIRMED]
- What is wrong: The provider cache/budget layer exists, but several routes still directly call providers.
- Concrete failure scenario: UI/enrichment/scanner routes burn provider quota outside the central budget/caching system.
- Why this matters: Free-tier data economics are central to the app’s reliability.
- Specific fix: Move all external market/fundamental/macro calls through typed provider adapters using `providerCachedFetch`.
- Required migration if any: None.
- Fail behavior: Over-budget returns stale cached data plus degraded confidence, not fake fresh data.
- Tests/verification: `rg "fetch\\(\"https://www.alphavantage|api.massive"` has only justified exceptions.
- Can a basic LLM fix this mechanically? yes route by route.

### P2-4 — Watchlist GET is public

- Severity: LOW
- Files:
  - `app/api/watchlist/route.ts`
- Exact location:
  - `app/api/watchlist/route.ts:21-56`
- Confidence: [CONFIRMED]
- What is wrong: Returns watchlist symbols, themes, notes, and flags with service role and no auth.
- Concrete failure scenario: Anonymous caller reads tracked symbols/research interests.
- Why this matters: Privacy leak; not direct money movement.
- Specific fix: Add `requireOwner()` to GET or strip private fields if public data is intentional.
- Required migration if any: None.
- Fail behavior: Unauthorized returns 401.
- Tests/verification: Anonymous GET returns 401.
- Can a basic LLM fix this mechanically? yes.

### P2-5 — Provider tier defaults can overstate capacity

- Severity: LOW
- Files:
  - `lib/data/provider-fetch.ts`
- Exact location:
  - `lib/data/provider-fetch.ts:27-36`
- Confidence: [CONFIRMED]
- What is wrong: EODHD defaults to `90000` even though the comment says free tier may be 20/day.
- Concrete failure scenario: User is on free tier; app believes huge budget exists and does not degrade/cap early.
- Why this matters: Capacity dashboard and provider decisions become misleading.
- Specific fix: Default to conservative/free tier unless env explicitly raises budget. Surface provider tier in Settings.
- Required migration if any: None.
- Fail behavior: Conservative cap triggers cached/stale fallback.
- Tests/verification: Without env var, EODHD budget is conservative/unknown, not 90000.
- Can a basic LLM fix this mechanically? yes.

## Architecture assessment

What is solid:

- The live order gateway design is directionally right: owner gate, CSRF/host guard, account allowlist, per-market caps, kill switches, fresh quote, data-quality gate, portfolio gate, SELL-held gate, atomic budget reservation, and needs-reconcile handling.
- Robinhood order placement is deterministic typed code, not an LLM-generated broker payload.
- The evidence ledger and strategy-version/challenger concepts are the right foundation for future learning.
- Per-market USD/INR separation is present in inspected order paths.

What is overbuilt:

- There are many dashboards, agents, RAG features, and mentor surfaces before the statistical learning core is strong.
- RAG can improve explanation, but it should not be treated as alpha evidence yet.

What is missing:

- A formal autonomy state machine.
- A uniform API authorization wrapper.
- Reproducible migration CI.
- A deterministic strategy optimizer / walk-forward validator.
- Explicit provider-tier configuration.

What is pretending to be intelligent but is not:

- Correlation-based weight nudging is not a reliable optimizer.
- Personal trade-history RAG is useful reflection, not market proof.
- A large number of parameters does not equal adaptive intelligence.

What should stay human-gated:

- Live orders at current stage.
- Strategy promotion.
- Money-limit increases.
- Broker account changes.
- Kill-switch re-enable.
- Unvalidated promotion override.

What can safely be automated later:

- Paper trading.
- Shadow decisions.
- Label maturation.
- Health triage as read-only.
- Limited autonomous live trading only after state-machine/evidence gates exist.

## Agent learning assessment

Current learning loop:

- Research writes signals and observations.
- Paper trading creates outcomes.
- Learner reads outcomes and can propose challenger weights.
- Strategy promotion is human controlled.

Why it is not statistically valid enough yet:

- Pearson/univariate correlation does not handle interactions, regimes, changing volatility, or selection bias.
- Sample sizes are likely thin.
- Filled trades and observed candidates are different populations.
- The learnable genome is too narrow if it mainly changes weights.
- RAG from personal history can help identify behavior patterns but cannot prove alpha.

Minimum correct roadmap:

1. Treat LearnerAgent as hypothesis generator, not optimizer.
2. Build deterministic walk-forward validation on observation labels.
3. Expand genome to thresholds, exits, sizing, universe, and data-quality rules.
4. Require shadow A/B before manual-live promotion.
5. Require manual-live evidence before bounded autonomy.

## Autonomy readiness assessment

Current autonomy level:

- Paper automation exists.
- Live execution is human-approved.
- No reviewed live route should autonomously submit orders today.

Safe to automate now:

- Research.
- Paper trading.
- Label maturation.
- RAG indexing after auth fixes.
- Health triage read-only.

Not safe yet:

- Autonomous live orders.
- Autonomous money/config/broker changes.
- Autonomous promotion to champion.
- Autonomous kill-switch re-enable.

Evidence required before promotion:

- Passed walk-forward validation.
- Enough effective samples.
- Clean reconciliation.
- Clean data-quality history.
- Shadow-live performance.
- Manual-live small-size evidence.

Required strategy lifecycle states:

`draft → testing → shadow_paper → paper_active → live_manual_eligible → live_manual_approved → live_autonomous_limited → live_autonomous_expanded → retired`

Required gates for limited autonomous live mode:

- Owner promotion.
- Strategy/account/broker scope.
- Hard notional caps.
- Daily budget.
- Fresh quote.
- Fresh account snapshot.
- Held SELL verification.
- Kill-switch safe.
- Reconciliation clean.
- Data-confidence sufficient.

How variable sizing should work safely:

Agent proposes size; deterministic sizing clamps by NAV %, per-order cap, daily cap, cash, liquidity, volatility, concentration, sector, drawdown, and autonomy tier.

## Live trading safety assessment

US Robinhood path:

- Good: owner gate, account allowlist, Robinhood enable flag, fresh quote, per-order cap, G1/G3, held SELL check, budget RPC, needs-reconcile.
- Needs fix: override audit must fail closed; route auth leaks must be fixed; migrations must be reproducible.

India Kite/Zerodha path:

- Good: owner gate, confirm flag, client order key, INR caps, fresh quote, held SELL check, G1/G3 parity, daily budget, GTT logging.
- Needs fix: override audit must fail closed; G3 skipped contract should be hardened.

Order gateway:

- Correct high-level choke point. Keep all future autonomy through this style of deterministic gateway.

Budget RPC:

- Design is right, but committed migrations do not reproduce latest fixes.

Account selection:

- Robinhood `robinhoodHeldQty()` now passes account into MCP; earlier wrong-account SELL risk appears fixed in code.

Kill switches:

- Current design disables trading and flags open orders for review; no auto-cancel is acceptable at this stage.

Overrides:

- Must become durable/fail-closed.

Reconciliation:

- Needs-reconcile exists. Do not enable autonomy until reconciliation is tested and boring.

Remaining unsafe paths:

- Unauthenticated service-role API routes.

## Supabase / schema / RLS assessment

- Good: sensitive RLS lockdown migrations exist for `api_key_vault`, `broker_orders`, `app_settings`, and `live_account_snapshots`.
- Bad: service-role API routes bypass RLS; therefore route-level owner/cron gates are mandatory and currently inconsistent.
- Bad: migrations 111/112 are not executable.
- Good: `decision_observations` and `paper_order_events` have append-only triggers.
- Watch: RAG/doc stores need versioned/corrective-event semantics if used as durable evidence.

## Data provider assessment

| Provider | Used by | Data dimensions | Free/paid/unknown | Rate-limit handling | Reliability risk | Recommended action |
|---|---|---|---|---|---|---|
| Alpha Vantage | Research, scanner, enrichment, earnings, insider fallback | fundamentals, indicators, news/sentiment, earnings, insider | Free default 25/day | Mixed cached/raw | Still bypassed in legacy routes | Keep fallback; route all calls through provider abstraction |
| Massive | Quotes/candles/live performance | price/candles | unknown | mixed direct/provider | per-minute limits | Add centralized adapter/cache |
| FMP | Fundamentals | ratios/key metrics | free/cheap | provider budget | field mapping risk | Keep with scale tests |
| EODHD | Candle fallback | daily candles | default assumes paid | provider budget | free-tier mismatch | Conservative default |
| Twelve Data | Candle fallback | daily candles | free/paid | provider budget | chronology risk | Keep sorted tests |
| Finnhub | analyst/earnings if wired | analyst/earnings | unknown | no daily cap | minute limits | Add minute throttling |
| FRED | Macro | macro series | free | provider cache | transformation correctness | Keep, test series math |
| Upstox | India data | instruments/candles | token/API | logged | token expiry | Surface expiry |
| Robinhood MCP | Broker/account/order | holdings/orders/NAV | broker | token CAS | OAuth/client policy | Deterministic adapter only |
| Kite/Zerodha | India broker | holdings/margins/orders/GTT | broker | token | daily token/reconcile | Keep with reconcile tests |
| TradingView | Manual validation | charts/fundamentals/technicals | user paid | no API | scraping ToS | Do not scrape; use manual/export/alerts only if allowed |

## US pipeline assessment

`symbol discovery → research → signal → decision_observation → paper trade → labels/learning → strategy challenger → validation/promotion → trade proposal → broker gateway → Robinhood MCP`

Strengths: coherent flow, evidence ledger, live gateway controls.

Weaknesses: validation and route security are not yet strong enough for live autonomy.

## India pipeline assessment

`India screen/NIFTY → research → India signal → INR paper pool / India dashboard → Kite order route`

Strengths: per-market caps and Kite parity improved.

Weaknesses: data quality is more fragile, India sample size likely thin, and direct dashboard/manual override needs better audit reason UX.

## Frontend / user-experience assessment

- API auth fixes may require UI to handle 401/403 states.
- India dashboard appears to send a generic manual override reason; better UX should require typed user reason for live BUY overrides.
- Privacy mode is not security. API routes must enforce auth.
- User-facing language should avoid implying proven autonomous alpha.

## Security assessment

Confirmed issues:

- Unauthenticated live portfolio APIs.
- Unauthenticated imported-trade delete APIs.
- Unauthenticated alerts route.
- Unauthenticated admin LLM cost/log APIs.
- Authenticated-only mutation routes that should be owner-only.

Good controls:

- `requireOwner()` is strong.
- `verifyCronSecret()` is timing-safe and fail-closed.
- `guardOrderRequest()` protects order routes.
- Robinhood MCP order payload is deterministic.

## Reliability / operations assessment

- Add fresh-DB migration replay CI.
- Add route-auth tests.
- Add provider-budget integration checks.
- Add reconciliation tests for ambiguous broker responses.
- Add smoke tests for dashboard API 401 handling after auth gates are added.

## Better architecture recommendations

### API authorization architecture

- Current design: each route handles auth manually.
- Verdict: refactor
- Why: service-role routes are inconsistently protected.
- Better design: `ownerRoute`, `ownerOrCronRoute`, `publicMarketDataRoute`, `internalOnlyRoute` wrappers.
- Migration path: convert P0 routes first, then add lint/CI grep check.
- Files likely affected: `app/api/**/route.ts`, `lib/auth/*`.
- Acceptance criteria: no `createServiceClient()` API route lacks an explicit approved guard.
- Priority: P0

### Learning/evolution architecture

- Current design: LLM proposes weight changes; server checks correlation.
- Verdict: refactor
- Why: not robust optimization.
- Better design: LLM finds hypotheses; deterministic optimizer validates.
- Migration path: keep strategy_versions; add stronger validation and genome.
- Files likely affected: `app/api/agents/learner/route.ts`, `lib/validation/*`, `app/api/strategies/versions/route.ts`.
- Acceptance criteria: no champion/autonomy promotion without passed walk-forward validation.
- Priority: P1

### RAG/evidence architecture

- Current design: trade memories upsert; doc chunks delete-then-insert.
- Verdict: patch
- Why: evidence memory should survive failed reingest.
- Better design: versioned active chunks.
- Migration path: add active/version columns and update retrieval.
- Files likely affected: `lib/rag/ingest.ts`, `supabase/migrations/120_doc_chunks_ingestion.sql`.
- Acceptance criteria: failed reingest preserves old active chunks.
- Priority: P1

### Provider architecture

- Current design: central provider abstraction exists but is not universal.
- Verdict: patch
- Why: free-tier economics require one choke point.
- Better design: all provider calls through typed adapters with budget/cache/staleness metadata.
- Migration path: convert raw fetch routes gradually.
- Files likely affected: `lib/data/*`, `app/api/live-portfolio/enrich/route.ts`, scanner/performance routes.
- Acceptance criteria: raw external market-data fetches are justified exceptions only.
- Priority: P2

### Autonomy architecture

- Current design: manual live now, future autonomy in docs.
- Verdict: refactor later
- Why: autonomy needs durable state, not comments.
- Better design: explicit strategy/account/broker autonomy states and hard caps.
- Migration path: add read-only autonomy state first; no autonomous order path until all gates exist.
- Files likely affected: strategy schema, settings, broker gateway, validation engine.
- Acceptance criteria: autonomous live order impossible unless strategy/account is promoted and deterministic gates pass.
- Priority: Phase 3

## Fix roadmap

### Phase 0 — stop live-money risk

- [ ] Add owner/cron gates to exposed service-role APIs.
- [ ] Make override audit writes fail-closed.
- [ ] Add executable migrations for 111/112 fixes.
- [ ] Convert config/learning mutation routes to owner-only.
- [ ] Add route-auth CI check.

### Phase 1 — make recommendations trustworthy

- [ ] Version RAG document chunks.
- [ ] Tighten strategy promotion.
- [ ] Move all provider calls through provider abstraction.
- [ ] Add data staleness/confidence display everywhere.

### Phase 2 — make learning real

- [ ] Walk-forward validation.
- [ ] Expanded strategy genome.
- [ ] Benchmark-neutral labels.
- [ ] Shadow A/B.

### Phase 3 — enable bounded autonomous trading

- [ ] Autonomy state machine.
- [ ] Strategy/account/broker scoped limits.
- [ ] Clean reconciliation gate.
- [ ] Tiny limited-autonomous mode only after evidence.

### Phase 4 — scale quality and automation

- [ ] Provider tier dashboard.
- [ ] Fresh migration replay CI.
- [ ] Route-auth E2E tests.
- [ ] Broker simulation/reconciliation tests.

## Mechanical fix list for Claude / basic LLM

| # | Priority | File(s) | Exact change | Acceptance test |
|---|---|---|---|---|
| 1 | P0 | `app/api/live-portfolio/route.ts`, `performance/route.ts` | Add `requireOwner()` at start of GET | Anonymous GET returns 401 |
| 2 | P0 | `app/api/live-portfolio/decisions/route.ts`, `files/route.ts` | Add `requireOwner()` to GET/DELETE; later soft-delete | Anonymous DELETE returns 401 |
| 3 | P0 | `app/api/alerts/route.ts` | Owner-gate GET/PATCH; remove/gate POST | Anonymous PATCH resolve_all returns 401 |
| 4 | P0 | `app/api/broker/orders/route.ts`, `app/api/kite/order/route.ts` | Await journal insert and fail on error before override proceeds | Simulated insert error blocks broker submit |
| 5 | P0 | `supabase/migrations/121_*`, `122_*` | Add executable function/view SQL for 111/112 fixes | Fresh DB has latest function/view |
| 6 | P0 | `agent-config`, `learner-controls`, `settings/pause`, `paper-positions/close` routes | Replace auth-only with `requireOwner()` | Non-owner returns 403 |
| 7 | P1 | `lib/rag/ingest.ts`, migration | Add versioned active chunks; no delete-before-insert | Failed reingest preserves old chunks |
| 8 | P1 | `app/api/live-portfolio/enrich/route.ts` | Add owner/cron gate | Anonymous POST returns 401 |
| 9 | P1 | `app/api/strategies/versions/route.ts` | Move force-unvalidated to explicit governance override path | Plain promote without validation returns 412 |
| 10 | P2 | `lib/risk/live-portfolio-gate.ts` | Replace ok/skipped with discriminated status | Stale NAV returns requires_override |
| 11 | P2 | `app/api/admin/llm-costs/route.ts`, `llm-log/route.ts` | Add owner/admin gate | Anonymous GET returns 401 |
| 12 | P2 | `lib/data/provider-fetch.ts` | Conservative provider defaults unless env override | EODHD default no longer 90000 |

## Clean sections

- Robinhood MCP order placement is deterministic typed code, not LLM-authored.
- Current US order route requires owner gate before broker submit.
- Current Kite order route has owner gate, confirm flag, idempotency key, fresh quote, G1/G3, held SELL check, daily budget.
- `verifyCronSecret()` is timing-safe and fail-closed.
- `requireOwner()` checks owner email and confirmed email.
- USD/INR caps are separated in inspected live order paths.
- SELL exits are exempt from BUY-only caps/budgets but still held-gated in inspected live paths.
- Health triage is read-only and cannot place orders or mutate trading config.

## Review limitations

STEP 0 access-proof results:

```text
PSQL_NOT_FOUND
```

Supabase JS service-role read-only attempt:

```json
{
  "paper_trades": {
    "count": null,
    "latest": null,
    "error": "column paper_trades.created_at does not exist"
  },
  "schema_migrations": {
    "data": null,
    "error": "Invalid schema: supabase_migrations"
  },
  "trade_memories": {
    "count": 0,
    "error": null
  }
}
```

Direct Postgres attempt with temporary `pg` package:

```text
FATAL: Invalid URL
```

How Supabase was reached: Supabase JS client using `.env.local` project URL and service-role key. This proved public-schema DB access and `trade_memories` existence, but did **not** prove access to `supabase_migrations.schema_migrations`. Therefore live migration-list verification was not proven in this session; migration-file findings are confirmed against repo files.

Other limitations:

- This was a targeted senior-risk/code review, not a complete line-by-line audit of every file.
- I did not run the app in browser during this pass.
- I did not call live broker APIs.
- I did not mutate Supabase.
- UI/runtime behavior, visual regressions, and every dashboard button still need a separate browser QA pass.
