# 07/08 Claude Fix Log — Kairos / FinanceOS

Scope: reviewed **both** `07_08_FULL_APP_REVIEW.md` and
`07_08_STRATEGIC_AGENTIC_TRADING_REVIEW.md`. Fixed only issues that are real,
concrete, and supported by current code. Every P0/P1 finding was classified
against the live source, not the review text. Migrations applied to prod are
additive-only. No autonomous live-order path was created; owner click remains
mandatory on every broker gateway.

**Classifications:** `REAL_FIX_NOW` (changed this work) · `ALREADY_FIXED`
(a prior session resolved it — verified in code) · `NOT_REAL` (finding does not
hold against current code) · `DEFER_STRATEGIC` (real but a larger strategic
build; not a live-money hole; deliberately not built to avoid overbuild).

## Findings table

| Finding | Classification | Files changed | Verification | Notes |
|---|---|---|---|---|
| **P0-1** Live-portfolio read routes not owner-gated | ALREADY_FIXED | — | `requireOwner()` present in `live-portfolio/route.ts:9` and `performance/route.ts:41` | Verified anonymous read is now gated; no code change needed. |
| **P0-2** Imported decisions/files readable/deletable without auth | ALREADY_FIXED | — | `requireOwner()` on GET+DELETE of `decisions/route.ts:8,32` and `files/route.ts:8,20` | Both mutating + read paths gated. |
| **P0-3** Safety migrations 111/112 not reproducible | ALREADY_FIXED | — | Executable `121_*`, `122_*` migrations exist and were applied (prior session); fresh DB replays latest budget/quality behavior | Comment-only 111/112 superseded by real DDL. |
| **P0-4** Live-risk override proceeds even if audit insert fails | ALREADY_FIXED | — | `broker/orders/route.ts:111-119` awaits insert, returns 500 on `auditErr`; `kite/order/route.ts:143-151,173-181` same fail-closed pattern | No silent `.then(()=>{},()=>{})` swallow remains on the override path. |
| **P0-5** Config/learning/pause/paper-close authenticated-only | ALREADY_FIXED | — | `requireOwner()` in `agent-config`, `learner-controls`, `settings/pause`, `paper-positions/close` route.ts | All four mutating routes owner-gated. |
| **P1-1** RAG ingest deletes old chunks before successful replace | REAL_FIX_NOW | `supabase/migrations/123_doc_chunks_versioned.sql` (applied), `lib/rag/ingest.ts` | Columns `ingest_version`/`active` + version-scoped unique constraint verified in prod; ingest now inserts new version, prunes old **only** after insert succeeds; `match_doc_chunks` filters `active` | Failed re-ingest leaves prior active version retrievable — evidence memory never lost. |
| **P1-2** Imported-trade enrichment POST not owner/cron gated | REAL_FIX_NOW | `app/api/live-portfolio/enrich/route.ts` | `requireOwner()` at `:68` before service client | Stops anonymous Alpha-Vantage burn + `trade_decisions` mutation. Sole caller is owner UI. |
| **P1-3** Alerts creatable/resolvable without auth | REAL_FIX_NOW | `app/api/alerts/route.ts`, `lib/alerts/emit.ts` (new), `app/api/broker/orders/sync/route.ts`, `app/api/agents/research/cron/route.ts` | GET/PATCH owner-gated, POST cron-or-owner; internal cron self-fetches replaced with `emitAlert()` service-client writes | Prevents anonymous resolve of safety alerts / injection of fake criticals without breaking internal alert emission. |
| **P1-4** Strategy promotion has force-unvalidated bypass | ALREADY_FIXED | — | `strategies/versions/route.ts`: POST owner-gated (`:46`), evidence gate fail-closed (`:63-89`), `force_unvalidated` journaled as `governance_override`, promotion sets `paper_active` (never live) | Bypass is owner-only, audited, and cannot reach a live state. Mitigated, not a hole. |
| **P1-5** Learner is not yet a robust optimizer | DEFER_STRATEGIC | — | — | Strategic Build 2 (learning genome). Large scope; weight mutation already evidence-bound + gated behind 10-trade unlock. Not a safety hole. |
| **P2-1** G3 portfolio gate makes skipped risk look like `ok` | DEFER_STRATEGIC | — | — | Contract refactor (discriminated union) across gate + callers. G3 still blocks on real breaches; this is truth/maintainability, not a live-money hole. Deferred to avoid scope creep. |
| **P2-2** Admin LLM cost/log APIs lack route auth | REAL_FIX_NOW | `app/api/admin/llm-costs/route.ts`, `app/api/admin/llm-log/route.ts` | `requireOwner()` at top of each GET | Cost/usage telemetry no longer anonymously readable. |
| **P2-3** Provider abstraction not universal | DEFER_STRATEGIC | — | — | Strategic Build 6. Architectural; no correctness/safety defect. |
| **P2-4** Watchlist GET is public | REAL_FIX_NOW | `app/api/watchlist/route.ts` | `requireOwner()` at `:23`; callers (BriefingSection, WatchlistPanel) are owner dashboard UI | GET now gated; POST/PATCH/DELETE were already user-gated. |
| **P2-5** Provider tier defaults can overstate capacity | DEFER_STRATEGIC | — | — | Needs an external budget/config decision (EODHD tier). Data-confidence work belongs with Build 6; not built speculatively. |
| **S1 / Build 1** Autonomy ladder (explicit level enforcement) | REAL_FIX_NOW | `supabase/migrations/124_autonomy_level.sql` (applied), `lib/autonomy.ts` (new), `app/api/broker/orders/route.ts`, `app/api/kite/order/route.ts` | Column `autonomy_level` default `L3_live_manual` verified on the singleton row (behavior preserved); both live gateways now require `liveOrdersAllowed(level)` (L3+) **above** `trading_enabled`; `AUTONOMOUS_LIVE_ENABLED=false` keeps L4/L5 defined-but-not-honored | Disabled-by-default ladder with owner click still mandatory (`requireOwner`). No autonomous live mode exists. |
| **S2 / Build 2** Mandatory validation before promotion | ALREADY_FIXED | — | `lib/validation/engine.ts:116-199` (walk-forward + moving-block bootstrap vs champion), `strategies/versions/route.ts:63-89` (fail-closed 412 promotion gate); mig `061` applied | Built prior session (commit `2e4db03`). Only escape is `force_unvalidated` — owner-only, journaled as `governance_override`, never reaches live state. |
| **S3 / Build 6** Autonomy ladder | REAL_FIX_NOW | see S1 row | — | Same as S1. |
| **S4 / Build 1** Learning genome as live control | REAL_FIX_NOW | `lib/validation/genome-live.ts` (new), `lib/research-agent.ts`, `app/api/agents/paper-trade/route.ts`, `tests/genome-live.test.ts` (new) | `loadChampionGenome` reads promoted champion `strategy_versions.genome`; research-agent entry threshold + paper-trade exit percentiles/horizon + Kelly cap/floor/mode now sourced from genome; genome `source`/`hash` stamped in stage log; build exit 0, 92 tests pass (6 new) | Genome now governs live behavior. **Money-safety:** genome cap clamped to owner `position_size_pct` (loop sizes down, never above). Behavior-preserving: `DEFAULT_GENOME` == prior hardcoded values, so genome-less markets unchanged; new behavior only after a genome-bearing challenger passes the fail-closed validation gate + owner promotion. No new migration (genome column live, mig 063). Deferred within scope: `universe.*`, `features.included`, `regime.router`, shadow-version genome. |
| **S5 / Build 5** Data-provider confidence layer | REAL_FIX_NOW (learner enforcement) | `lib/learning/taint-filter.ts` (new), `app/api/agents/learner/route.ts`, `tests/learner-taint-filter.test.ts` (new) | Both learner `paper_trades` reads (`:283`, `:324`) now routed through `applyLearningTaintFilter` → `.or("excluded_from_learning.is.null,excluded_from_learning.eq.false")`; golden tests lock the filter string + keep/drop decision (3 pass); prod check: 6 trades, 0 tainted → behavior-preserving today, protective once stamping populates | Enforcement flip turned ON per mig-116 gate (golden tests first). null (pre-116) + false = trusted/kept; only explicit `true` dropped — no legacy starvation. **Deferred (named):** taint propagation to `decision_observations`/`observation_labels` for the validation walk-forward (those tables lack taint cols — needs a separate additive migration); per-feature/provider/last-updated attribution; the confidence-*stamping* pipeline (prod `data_confidence` is null on all rows — stamping not yet populating). |
| **S6 / Build 4** Realistic paper execution | DEFER_STRATEGIC (PARTIAL) | — | Ask + flat 0.05% slippage; bid/ask/spread recorded (`execute_paper_fill`, mig `117`); cash-locked, transactional; cash/notional-cap rejections | No partial fills, no illiquid rejection, no next-bar/next-open, no expected-vs-realized quality tracking. |
| **S7 / Build 3** Performance-truth dashboard | REAL_FIX_NOW | `lib/analytics/performance-metrics.ts` (new), `app/api/agents/performance/metrics/route.ts` (new), `components/dashboard/PerformanceTruth.tsx` (new), `components/dashboard/LearningPage.tsx`, `tests/performance-metrics.test.ts` (new) | Pure metrics lib (Sharpe/Sortino/max-DD/expectancy/profit-factor/cost-net/calibration) with an HONESTY CONTRACT — every estimator carries `n`+`insufficient`, small samples render "too small" not a fake number (MIN_RETURNS/TRADES=20, MIN_CALIB=10); owner-gated GET route computes per-market (us/india) from `paper_performance` (nav/spy_return_pct/alpha_pct) + closed `paper_trades`; dashboard section on `/dashboard/learning` with metric tiles, gross-vs-net cost bars, calibration curve, market slicer, mobile-first; 18 golden unit tests pass; **schema verified in prod** via `information_schema` (all 13 columns present on `paper_performance`/`paper_trades`); build exit 0 | Pure-additive read layer, zero live-money risk, zero migration. **Truth stance:** dashboard COUNTS tainted trades (opposite of the Build 5 learner filter) — the book still moved, so P&L must not hide them; tainted surfaced as its own field. **Deferred (named):** sector slice (sector lives on `paper_positions`, not `paper_trades` — needs a symbol join); regime slice (join to `macro_regime.week_of`); fitted `predictPWin` calibration from `model_artifacts` (dashboard uses raw `analyst_score/100` deciles); direction slice. |

## Migrations applied to prod this review

| Migration | Purpose | Applied | Additive |
|---|---|---|---|
| `123_doc_chunks_versioned.sql` | Durable RAG re-ingest (P1-1) | ✅ verified | Yes |
| `124_autonomy_level.sql` | Autonomy ladder column + check (S1) | ✅ verified | Yes |

(`121`/`122` for P0-3 were applied in the prior session.)

## Hard constraints honored

- No wholesale redesign; no speculative features.
- **No autonomous live trading enabled.** L4/L5 are declared but not honored;
  `AUTONOMOUS_LIVE_ENABLED=false`; `requireOwner()` gates every live order.
- No LLM path can place/cancel live orders, mutate money limits, mutate active
  live strategy config, or approve its own promotion.
- No append-only ledger deleted or mutated. All migrations additive.
- US (USD) and India (INR) money limits remain currency-separated.
- Long-only new-position behavior + SELL-only-if-held preserved (untouched).
- FinNudge untouched. No secrets committed.
- Production build passes (`npm run build`, exit 0).

## Verification summary

- `npm run build` → success (full route table emitted, no type/compile error).
- Autonomy default confirmed against prod: `strategy_config.autonomy_level =
  'L3_live_manual'` → `liveOrdersAllowed` true → current owner-driven live
  behavior unchanged (nothing newly blocked or newly allowed).
- Migration 123/124 columns + constraints confirmed present in prod via
  `information_schema` / `pg_constraint` checks.
