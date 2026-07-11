# WORK_LOG.md — Active Task Tracker

| Full US/India pipeline verification and remediation | Codex / GPT-5 | completed | 2026-07-11 | Fixed leaked cron credential/Vault scheduling, stale-check auth/time math, US label candle fallback, learner market collision/timeouts, SEC insider classification + AV quota waste, paper-run market attribution, Supabase invoker views/search path, and vulnerable disabled PWA chain. Applied migrations 159–160; 45 labels matured; 281 tests/typecheck/build/audit green; no orders submitted. See `CODEX_US_INDIA_PIPELINE_FINAL_AUDIT.md`. |

| Daily Per-Holding Risk Analytics (full build) | Claude / Opus 4.8 | review | 2026-07-11 | Built the approved feature end-to-end. **Engine** `lib/risk/holding-risk.ts` (`computeHoldingRisk`, formula `hr-v1`): deterministic 0–100 risk-control pressure index (caps name30/sector20/vol-beta15/cluster15/drawdown10/liquidity10) + posture with strict precedence (verified stop/thesis-break→exit_review; drawdown ALONE never; hard concentration/cluster breach→trim; confidence<0.5→review; else hold). LLM writes `strategy_note` ONLY — cannot change score/posture/action. `lib/risk/correlation.ts` aligned-return clusters. **Schema** migrations 154 (3 append-only tables `holding_risk_runs` lifecycle-guarded + `holding_risk_snapshots`/`account_risk_snapshots` UPDATE+DELETE-blocked, owner-email RLS, anon REVOKEd), 155 (claim/publish RPCs), 156 (pg_cron US 21:30 UTC / India 11:00 UTC) — **all applied + verified** (tables, 3 triggers, 6 RLS policies, both cron jobs active). **Cron** `POST /api/agents/holding-risk?market=` fails closed on missing/stale snapshot. **Read API** `GET /api/portfolio/risk-daily` (owner-RLS, complete runs only, same-formula Δ). **UI** `PortfolioRiskPage.tsx` Daily Per-Holding Risk panel: per-account tabs, cadence header, per-holding score chip + posture pill + Δ1d + driver breakdown + advisory note. **ADVISORY-ONLY — wired to NO order path for ALL accounts** incl. read-only 965848641; no cross-currency roll-up. Docs: arch 04/05/08 + system-map.json (ACCTBOOK→HOLDINGRISK→RISKDASH + history). Gates: tsc 0 · vitest 281 pass/6 skip (33 new holding-risk/correlation) · build ok (/dashboard/risk 8.1 kB). No live/autonomous enablement; no real order placed/previewed/canceled/modified. |
| Holding-risk-daily architecture review | Codex / GPT-5 | completed | 2026-07-11 | Updated `features/holding-risk-daily/FEATURE_ARCHITECTURE.md`: fixed append-only/upsert conflict, account/currency provenance, Kite identity, score semantics, risk-vs-alpha action boundary, stale/missing data, idempotency, RLS, failure behavior, and acceptance tests. Documentation only. |

| Phase B P0 re-audit remediation (Codex#1-6) | Claude / Opus 4.8 | completed | 2026-07-11 | Fixed all 6. #1 CRITICAL migration **153** drops `p_broker` from advisory-lock key → market-wide scope match. #2 CRITICAL `verifyKiteTradingIdentity()` binds Kite `/user/profile` `user_id` to `active_account_india`. #3 HIGH gate lives at `placeEquityOrder` choke point (all Kite paths). #4 HIGH 153 rejects non-finite qty/notional/caps + validates side/env/broker/symbol/order_type. #5 MED added ACK live-path test (`attempts()===3`, 202, broker-id-in-alert) + `attempts()===1` on broker-reject. #6 LOW fix-log wording. Migration 153 verified applied. arch-08 + system-map.json updated (also repaired 8 pre-existing raw ctrl-chars in diagram). Gates: tsc 0, vitest 248 pass/6 skip, build OK. No real order placed; autonomous/live OFF. |
| Phase B P0 remediation adversarial re-audit | Codex / GPT-5 | completed | 2026-07-11 | Wrote `CODEX_PHASE_B_REMEDIATION_REVIEW_RESULT.md`. Found CRITICAL cross-broker budget-lock race and incomplete Kite token/account identity binding across standalone/canonical paths; HIGH incomplete RPC finite/input validation; A3 focused tests and tsc pass; A4 and edge cleanup clean. Live DB checked read-only. |

> **All agents check this before starting work. Claim your task. Update when done.**
> Format: `| Task | Agent/Model | Status | Date | Notes |`

---

## 🚧 Session 2026-07-11 — Codex full-review remediation (Phase A P0)

| Task | Agent/Model | Status | Date | Notes |
| --- | --- | --- | --- | --- |
| Phase A P0 remediation (kill-switch book/account, Kite unify, durable ACK, PositionMonitor NAV, budget RPC grants) | Claude Opus 4.8 | review | 2026-07-11 | From 07_08_FULL_APP_REVIEW.md. **A1 (kill-switch book/account), A3 (durable broker ACK), A4 (PositionMonitor NAV accounting), A5 (budget-RPC grants + v2 session, applied) DONE. A2 (canonical Kite path) DEFERRED — needs architecture approval.** Gates green: tsc clean · vitest 243/6 skip (+5 Test 9c) · build ok. DB verified: v1/v2 RPC grants = {postgres,service_role} only; paper_portfolio has no open_positions col; live_account_snapshots schema-backed. Evidence: `07_11_CLAUDE_FULL_APP_FIX_LOG.md` + `07_11_P0_ACCEPTANCE_EVIDENCE.md`. No live/autonomous enablement. STOPPED after Phase A per prompt. |
| Phase B remediation (residual P0 items under owner "go fix all") | Claude Opus 4.8 | review | 2026-07-11 | Closes the Phase-A residuals. **A3 injected-failure integration test** (`tests/execute-order-ack.test.ts`, 4/4: 3-attempt ACK retry → 202 needs_reconcile, exactly-once broker submit, CRITICAL alert). **A2 additive identity/allowlist gate** on `app/api/kite/order/route.ts` — reads `strategy_config.active_account_india`, requires `broker_accounts{kite,india,trading}`, fail-closed 403/500 (no contract change; no kite row exists today so India live is blocked until owner adds one — intended). **A4 read-only NAV reconciliation report** `GET /api/paper/nav-reconcile` (owner-gated, zero writes; surfaces current drift US $61.28 / India ₹51,505.90). **A5 tz-boundary read-only proof** of v2 market-local session date + advisory-lock concurrency note; migration-152 tracker note corrected (tracked `20260711135037`). **Deleted** dead edge-fn `supabase/functions/_shared/kill-switches.ts`. Gates green: tsc clean · vitest 247/6 skip (+4) · build ok. Canonical Kite-path *unification* + correcting the 2 drifted NAV pools remain owner-gated. No live/autonomous enablement; no real order placed/previewed/canceled/modified. Evidence updated in both 07_11 docs. |

---

## Status Key
- `planned` — approved, not started
- `in_progress` — actively being worked on (DO NOT start if another agent claims this)
- `blocked` — waiting on dependency or Vaibhav decision
- `review` — done, needs Vaibhav or Reviewer check
- `completed` — shipped

---

## ✅ Session 2026-07-09 — Risk gates + Performance Truth Layer (all built)

| Task | Agent/Model | Status | Date | Notes |
| --- | --- | --- | --- | --- |
| Re-entry cooldown | Claude Sonnet 4.6 | completed | 2026-07-09 | Blocks same-symbol BUY for 5 calendar days (≈3 trading days) after position closes. Applied in paper-trade route after sector-cap check. `cooldownCutoff = now - 5d`, counts closed paper_trades with order_side=buy, market-aware. |
| Pyramid gate | Claude Sonnet 4.6 | completed | 2026-07-09 | If open position exists and fillPrice ≤ avg_cost → revert claim + skip with reason "pyramid_gate". Blocks averaging down into a losing position. Only allows adding to winners. |
| Time stop | Claude Sonnet 4.6 | completed | 2026-07-09 | PositionMonitor closes positions older than champion genome's `horizon_days` (default 10). `loadChampionGenome()` per market, cached in `horizonDaysByMarket`. Runs before score-exit check. Prevents slow bleeds that overstay the swing window. |
| Partial profit-taking (B) | Claude Sonnet 4.6 | completed | 2026-07-09 | At price target, close floor(qty/2) shares, move stop_loss to avg_cost on remainder (breakeven). Credits half-proceeds to cashByMarket. Only when qty ≥ 2 (single share = full close). FIFO lot close on paper_trades. |
| NAV drawdown circuit breaker (A) | Claude Sonnet 4.6 | completed | 2026-07-09 | PositionMonitor fetches paper_performance for each market, computes weekly NAV return. If < -5%, sets app_paused=true in strategy_config + fires critical System Health alert `nav-drawdown:<market>`. |
| Benchmark sync (C) | Claude Sonnet 4.6 | completed | 2026-07-09 | PositionMonitor fetches VOO (US) and ^NSEI (India) price daily via getQuote(), upserts paper_performance.bench_nav. Alpha now compares against live benchmark NAV. |
| P1 gate cron | Claude Sonnet 4.6 | completed | 2026-07-09 | Weekly Sunday 02:00 UTC cron at /api/agents/evaluation/p1-gate/cron. Counts closed evaluable paper_trades per market. ≥ 20 → reportIssue(`p1_gate_ready:<market>`, info). < 20 → resolveIssue. Added to vercel.json crons array. |
| P0 Performance Truth Layer | Claude Sonnet 4.6 | completed | 2026-07-09 | Migrations 133/134/135 applied (investment_mandates, strategy_evaluations append-only, mandate_id FK on agent_signals/paper_trades/decision_observations). lib/evaluation/run-evaluation.ts (pure deterministic math, no LLM). /api/agents/evaluation/run + /results + /mandates routes (owner-gated). PerformanceTruth.tsx additions: mandate selector + Run Eval button + eval history table. eligible_for_live_review advisory only — never read by broker gateway. |
| TypeScript scope fix | Claude Sonnet 4.6 | completed | 2026-07-09 | position-monitor route.ts: `market` variable was declared inside `if (pos.created_at)` block (time stop), not visible to partial profit-taking block below. Hoisted to top of position for-loop. Build was failing `Cannot find name 'market'`. |

---

## ✅ Session 2026-07-10 — Scoring P0/P1/P2 + Live PA0 schema/UI/audit

| Task | Agent/Model | Status | Date | Notes |
| --- | --- | --- | --- | --- |
| Scoring + live-auto architecture hardening review | Codex / GPT-5 | completed | 2026-07-10 | Corrected four architecture docs. Fixed wrong RH account, Gateway bypass, non-atomic auto budget, fallback NAV, missing exit/reconcile prerequisite, scoring confidence math, rank-universe design, LLM boundaries, calibration leakage, lifecycle/promotion, and ledger semantics. Added Claude staged verification/build prompt. Documentation only; no production code. |
| Scoring P2 — shadow setup experts (6 archetypes) | Claude Sonnet 4.6 | completed | 2026-07-10 | Migration 138: `policy_version_id` dropped NOT NULL on shadow_decisions; `setup_type text` col + index added. lib/scoring/archetypes.ts: 6 archetype configs (quality_momentum/value_inflection/post_earnings_drift/etf_trend/india_quality_momentum/india_sector_rotation) with prior weights + router + computeArchetypeScore. ResearchAgent: after existing shadow_versions block, calls routeToArchetypes() + inserts archetype shadow rows (policy_version_id=null, setup_type=archetype.id). All archetypes score in shadow; only champion v1 creates actionable signal. Build green. |
| Scoring P1 — universe snapshots + cross-sectional rank (measure-only) | Claude Sonnet 4.6 | completed | 2026-07-10 | Migration 137: universe_snapshots + universe_snapshot_scores tables. Cron creates PIT snapshot before parallel workers, passes snapshot_id to each processSymbol call. Post-run: computes percentile rank (0=worst, 1=best), inserts universe_snapshot_scores. decision_observations.universe_snapshot_id populated. features blob adds schemaVersion:'v1' + decisionTs. No paper/live change. Build green. |
| Scoring P0 — provenance safety + mechanical direction gate | Claude Sonnet 4.6 | completed | 2026-07-10 | Migration 136 applied: `score_source`+`scoring_version` on `agent_signals`; 10 summary cols on `decision_observations` (with NOT VALID range guards); 3 new lifecycle states on `strategy_versions` (`measure_only`, `live_review_eligible`, `live_approved`). Code: ResearchAgent writes `score_source='deterministic_v1'`+`scoring_version='v1.0'` + `evidence_confidence` on every signal+obs insert; mechanical direction gate replaces LLM direction for non-exit signals (score≥threshold→long, else neutral). DeepSeek writes `score_source='llm_advisory'`. PaperTrader + TraderAgent: `.or("score_source.is.null,score_source.neq.llm_advisory")` structural exclusion gate added. Build green. Deployed. |
| Live PA0 — schema, audit RPC, Settings UI (deployment flag stays false) | Claude Sonnet 4.6 | completed | 2026-07-10 | Migration 139: strategy_config +8 live_auto_* cols (all false/null/conservative defaults, NOT VALID range guards); trade_proposals +4 cols + status constraint expanded (queued_auto, manual_review_required); broker_order_events append-only table + boe_block_mutation() UPDATE/DELETE trigger. Migration 140: reserve_live_order_budget_v2 RPC (adds p_execution_actor param; approved_by_user=(actor='owner'); fixes v1 budget gap — counts unknown_needs_reconcile+partially_filled; REVOKE public/anon/authenticated GRANT service_role). lib/autonomy.ts: AUTONOMOUS_LIVE_ENABLED=false const. app/api/settings/live-auto/route.ts: GET returns config+deployment_flag_active; PATCH enable (requires AUTONOMOUS_LIVE_ENABLED=true+confirmation_text='ENABLE AUTO'+lease_hours 1-24, journal write before config); disable; update_caps (min_confidence floor≥0.6). Settings page agents tab: LiveAuto card with deployment flag status, DB toggle+lease display, typed confirmation enable panel, disable button, caps inputs. Build green. |

---

| Docs: system-map.json + arch chapters for PA0-PA2 | Claude Sonnet 4.6 | completed | 2026-07-10 | system-map.json: AUTOSHADOW + SHADOWPROP nodes + edges + history. docs/arch/04-database-schema.md: live_auto_* cols on strategy_config, trade_proposals autonomous cols, broker_order_events table, migrations 136-140. docs/arch/05-crons-and-scheduling.md: autonomous-shadow Vercel cron. docs/arch/08-risk-and-safety.md: PA2 sizing table + PA3 blocker noted. |
| Live PA2 — sizing kernel + budget dry-run in shadow path | Claude Sonnet 4.6 | completed | 2026-07-10 | execution-kernel.ts: computeAutonomousSizing() — no-fallback NAV (4h stale = fail closed), Kelly from paper_trades (≥10 closed), per-order cap clamp, floor 2%, qty rounds down (< 1 = no size). autonomous-shadow.ts: fetches live_account_snapshots NAV (account 605420660 read-only), paper_trades for Kelly, getQuote() per qualifying signal, budget dry-run (informational: broker_orders spend vs daily cap). queued_auto proposals now have qty/estimated_value/pct_of_nav/price_at_proposal. Sizing failure → downgrade to manual_review_required. Note: broker preview+submit NOT implemented — route handlers cannot call Robinhood MCP (TraderAgent itself documents this limitation at line 429). Actual execution remains owner-triggered via MCP session. Build green. |
| Live PA1 — shared execution kernel + shadow autonomous decisions | Claude Sonnet 4.6 | completed | 2026-07-10 | lib/trading/execution-kernel.ts: pure evaluateAutonomousExecution() with 9 ordered gates (deployment_flag/db_toggle/lease/long_only/score/confidence/max_positions/max_orders/notional). lib/trading/autonomous-shadow.ts: runAutonomousShadow() — snapshots policy, queries qualifying signals (deterministic, long, score≥threshold, last 24h), creates trade_proposals (execution_mode='autonomous_shadow'), runs kernel, updates status to queued_auto or manual_review_required, journals run. Routes: POST /api/agents/autonomous-shadow/run (requireOwner), POST /api/agents/autonomous-shadow/cron (CRON_SECRET). Cron: weekdays 07:30 UTC. Gate 1 always fires in current deployment (AUTONOMOUS_LIVE_ENABLED=false) — all proposals land manual_review_required intentionally. No broker calls, no budget reservation, no order submission. Build green. |

---

## ✅ Session 2026-07-10 (cont'd) — Phase 1 P0 audit fixes

| Task | Agent/Model | Status | Date | Notes |
| --- | --- | --- | --- | --- |
| Phase 1 P0 fixes — Codex audit 4.2/10 → 8 confirmed findings repaired | Claude Sonnet 4.6 | completed | 2026-07-10 | Migration 147 (schema reproducibility). 7 code fixes: conviction/100 confidence normalization (was always 0, blocked all autonomous signals); L4 autonomousWorkerAllowed() gate in execute-order.ts; India USD-cap isolation in execution-kernel.ts; duplicate SELL atomic claim in live-exit-monitor.ts; cancel-on-kill BUY-only in sync/route.ts. F2 (RPC security) already fixed in prod (anon_can_exec=false confirmed). F6 (kill-switch live data) deferred — AUTONOMOUS_LIVE_ENABLED=false, blocking prerequisite documented in POST_UPGRADE_FIX_LOG.md. Build green. |

---

## 🔴 In Progress

| Task | Agent/Model | Status | Date | Notes |
| --- | --- | --- | --- | --- |
| 2026-07-11 current-tree full app adversarial review | Codex / GPT-5 | completed | 2026-07-11 | Reviewed current commit `cbf8617`, live Supabase read-only state, US/India pipelines, scoring/learning, manual/autonomous money paths, providers, UI, security, and reliability. Wrote `07_08_FULL_APP_REVIEW.md` and `CLAUDE_CODE_07_11_FULL_APP_FIX_PROMPT.md`. Found P0 kill/SELL semantics, unscoped Kite account, post-submit durability, broken paper NAV projection, exposed v1 RPC, and evidence-empty learning. 238 tests pass/6 skipped; typecheck fails; localhost returned 500. |
| Post-remediation deep quant/system re-audit | Codex / GPT-5 | completed | 2026-07-10 | Wrote CODEX_REMEDIATION_REVIEW_RESULT.md, CODEX_POST_UPGRADE_DEEP_REVIEW_RESULT.md, and CLAUDE_CODE_POST_UPGRADE_FIX_PROMPT.md. Found incomplete migration/RPC grants, renewed zero-confidence dead-end, missing L4/live-approved gates, India cap mixing, paper-based live kill switches, unsafe/US-only exits, unofficial RH REST, discovery/formula/evolution gaps, and meme reversal false-positive. 142 tests pass; build timed out unverified. |
| Full-system adversarial audit | Codex / GPT-5 | completed | 2026-07-10 | Wrote CODEX_FULL_SYSTEM_AUDIT_RESULT.md. Found autonomous gateway bypass, missing on-disk migrations 139/140, broken signal confidence query, India currency/NAV mixing, no live exit lifecycle, learning/calibration defects, API/RLS/vault gaps, and material docs drift. 116/116 tests pass. |
| Momentum factors + trade-behavior mirror adversarial review | Codex / GPT-5 | completed | 2026-07-10 | Wrote CODEX_MOMENTUM_BEHAVIOR_REVIEW_RESULT.md. Found Feature Registry is log-only, current archetypes are static reweights rather than momentum models, EdgeIC retains survivorship/horizon-selection risk, fade premise is unproven, and trade CSV/enrichment cannot support behavioral claims before parser/episode/outcome repair. Added exact falsification test and revised phased recommendation. |
| Edge/Factor broaden IC evidence (measure-only) | Claude/Opus 4.8 | completed | 2026-07-09 | Curated static liquid universe (lib/edges/universe.ts, US+India, labeled NON-PIT/survivorship) + deeper multi-year candle history + universe/offset/historyDays params on edge-scout & edge-ic so the broad list is processed in bounded, cached, paged slices. Still measure-only; no trading/scoring/sizing change. Purpose: make IC trustworthy before P2. |
| Edge/Factor Discovery P1 IC gate (measure-only) | Claude/Opus 4.8 | completed | 2026-07-08 | DONE + deployed (commit f2cc41a). lib/edges/ic.ts (rank-IC vs forward returns by horizon, Newey-West t for overlapping returns, IR, lifecycle classifier) + app/api/agents/edge-ic (bounded measure-only) + IC scorecard on /dashboard/edges. Verified live: 24 edge_ic_history rows (8 edges×3 horizons); classifier flagged momentum/trend/rel-strength shadow_eligible (t≥2), weak edges measure_only, st_reversal benched_negative@20d; trading tables unchanged (98/6/11/2). Honest caveat: illustrative not proof (30-name tech-heavy universe, ~50 recent dates, survivorship). Evidence in features/edge-factor-discovery/P0_BUILD_RESULT.md (P1 section). P2 NOT built. |
| Edge/Factor Discovery P0 (measure-only) | Claude/Opus 4.8 | completed | 2026-07-08 | DONE + deployed (commit be06584). migration 132 applied+verified (edge_catalog, edge_universe_members, edge_signals, edge_signal_inputs, edge_ic_history). lib/edges/* (8 price/volume edges, cross-sectional z, bounded cached candle resolver). app/api/agents/edge-scout (owner-or-cron, measure-only, bounded maxSymbols/maxDays, idempotent, provider report). Read-only /dashboard/edges catalog page. NO change to analyst_score/agent_signals/paper fills/sizing/live orders (verified). Build+typecheck green (51/51). Evidence + verification table in features/edge-factor-discovery/P0_BUILD_RESULT.md. Verified live: bounded run wrote 25 universe + 154 edge_signals (8 edges) + 154 PIT input rows; rerun idempotent (still 154); trading tables unchanged (agent_signals 98, paper_trades 6, paper_order_events 11, broker_orders 2 before AND after). P1 (IC gate) NOT built. |
| 07/08 review fixes (P0+P1+P2 auth/durability) + strategic autonomy ladder (S1) | Claude/Opus 4.8 | done | 2026-07-08 | P0-1..P0-5 verified fixed (auth gates + fail-closed override audit + reproducible migs 121/122). P1-1 durable RAG re-ingest (mig 123 + lib/rag/ingest.ts). P1-2 enrich owner-gate. P1-3 alerts auth + lib/alerts/emit.ts. P2-2 admin LLM APIs auth. P2-4 watchlist GET auth. S1 autonomy ladder: mig 124 `autonomy_level` (default L3_live_manual) + lib/autonomy.ts + both live gateways enforce `liveOrdersAllowed` above trading_enabled; L4/L5 defined-but-not-honored (AUTONOMOUS_LIVE_ENABLED=false, owner-click still required). P1-5/P2-1/P2-3/P2-5 + Builds 2–6 = DEFER_STRATEGIC (documented, not overbuilt). Full classification in 07_08_CLAUDE_FIX_LOG.md. Build passes. |

---

## ✅ Session 2026-07-08 (cont'd) — Strategic Report Tier-3 + Tier-4 (all built)

> User re-supplied VOYAGE_API_KEY + WANDB_API_KEY and said "go" to build ALL remaining tiers with my defaults (pgvector not Qdrant; reuse WandB Weave not a separate OTel vendor; native typed layers not heavyweight frameworks — no new signups). Every RAG/observability feature is env-gated: absent key → graceful no-op, never throws.

| Item | What was built | Migrations |
|---|---|---|
| #10 Trade-history RAG | `lib/rag/embeddings.ts` (Voyage voyage-3.5, 1024-dim, graceful-null) + `lib/rag/trade-memory.ts` (`buildSetupDocument`/`indexClosedTrade`/`retrieveSimilarTrades`/`summarizeMemories`). `trade_memories` table + `match_trade_memories` RPC (hnsw cosine). Wired into ResearchAgent thesis prompt ("prior similar setups & outcomes", cross-symbol, same market) + indexed at close time in position-monitor & learner. Tainted/excluded trades never enter corpus. `/api/agents/rag-backfill` bootstraps corpus. | 118 |
| #9 Reranker | `lib/rag/rerank.ts`: Voyage **rerank-2** (reuses VOYAGE_API_KEY — no HuggingFace). Two-stage: ANN over-fetch 20 → rerank → top-k. Identity fallback when disabled. | — |
| #11 Binary context filter | `lib/rag/contextual.ts` wires `filterChunksByTicker` (entity guard) into the document-RAG path + traces the keep/reject decision. Trade-memory path is cross-symbol by design (no ticker filter). | 119 |
| #12 Contextual Retrieval | `lib/rag/contextual.ts`: per-chunk LLM context header (Anthropic contextual retrieval) via cheap `summarize` tier; graceful passthrough on failure. | — |
| #13 Vector DB | **pgvector 0.8.0** in existing Supabase (no Qdrant). `trade_memories` + `doc_chunks` embedding columns, hnsw indexes. | 118, 120 |
| #14 Tracing | `lib/observability/weave.ts`: `traceRag()` writes durable `rag_traces` (source of truth) + mirrors to WandB Weave when WANDB_API_KEY set. Every retrieve/rerank/filter/index op traced. | 119 |
| #15 Orchestration | `lib/agents/graph.ts`: native typed `StateGraph` (nodes/edges/conditional routing/shared state/`onStep` checkpoint seam) modeling LangGraph without the dep. | — |
| #16 Ingestion | `lib/rag/ingest.ts`: LlamaIndex-style pipeline (chunk → #11 filter + #12 contextualize → embed → store) into `doc_chunks` + `retrieveDocChunks` (ANN→rerank). Sentence-aware splitter with overlap. | 120 |
| #17 A2A contracts | `lib/agents/contracts.ts`: versioned typed envelopes for every handoff (Signal→Decision→Fill→Outcome) + `validateMessage()` runtime guard. | — |

**Framework decisions (recorded):** #13/#14/#15/#16 chose native/existing-infra over new vendors (pgvector over Qdrant, WandB reuse over separate OTel, native StateGraph over @langchain/langgraph, native pipeline over llamaindex.ts) — same architecture value, no bundle bloat / cold-start hit / new signup. All keys already in Vercel Production + Preview.

**Strategic Intelligence Report: ALL 17 items now built (Tiers 1–4 complete).**

---

## ✅ Session 2026-07-08 — Strategic Report Tier-1 + Tier-2 (all built)

> User mandated building all unbuilt items from the Strategic Intelligence Report. This session completed Tier-1 (prompt caching, ticker filter, prompt versioning, DeepSeek data gate) and Tier-2 (Agent Evolution discovery_source, B3 structured triage, Data Provider Abstraction, Learning Integrity Phase 1B).

| Item | What was built | Migrations |
|---|---|---|
| #1 Prompt caching | `lib/llm-router.ts`: `callClaude`/`runClaudeAgentLoop` pass `cache_control: ephemeral` on system blocks; `LLMResult` tracks `cacheWriteTokens`/`cacheReadTokens`; cost formula uses 1.25×/0.10× cache rates | — |
| #2 Ticker filter | `lib/ticker-filter.ts` (NEW): `filterChunksByTicker()` + `chunkMentionsTicker()` — entity-level RAG chunk validation, strips exchange suffixes (.NS/.BO) | — |
| #3 Prompt versioning | `agent_config` gains `prompt_version/hash/notes/updated_at`; `agent_runs` gains `prompt_version/hash` | 113 |
| #4 DeepSeek data gate | `lib/research-agent.ts`: model = `claude-haiku` when `technical`/`fundamental` dims included, `deepseek-v4-flash` fallback when APIs returned nothing | — |
| #5 Learning Integrity Phase 1B | `paper_trades`/`broker_orders` gain 5 taint columns; `execute_paper_fill` RPC auto-stamps quality at fill time from `v_decision_quality`; `features.quality` structured per-dim state logged on every `decision_observations` row | 116, 117 |
| #6 Agent Evolution — discovery_source | `SymbolEntry` gains `discovery_source` type; all 9 sources tagged in `gatherSymbols()`; `decision_observations` gains `discovery_source` column + index; research inserts it per signal | 114 |
| #7 B3 structured triage | `health-triage` route now requests JSON `{summary, issues[{issue_key, severity, root_cause, blast_radius, suggested_fix}]}`; `health_triage` table gains `structured_issues jsonb`; GET returns it | 115 |
| #8 Data Provider Abstraction | `lib/data/provider-interface.ts` (NEW): `DataProvider` interface, `OverviewResult/CandleResult/NewsResult` types, `AlphaVantageProvider` implementation, `getProvider()`/`tryProviders()` registry | — |

**Remaining unbuilt (Tier-3 require external API keys, Tier-4 needs infra decisions):**
- Tier-3: gte-reranker (HuggingFace key), voyage-3.5 trade RAG (VOYAGE_API_KEY), WandB Weave binary filter (WANDB_API_KEY), Contextual Retrieval (depends on voyage)
- Tier-4: Qdrant, OpenTelemetry, LangGraph 1.0, LlamaIndex, A2A typed messaging

---

## ✅ Session 2026-07-07 (cont'd) — Agent Mind (all 3 phases) + learning_priors seed

> User approved the Agent Mind feature (surface what the agents believe, how it evolves, macro-to-holdings read). Also seeded/cleaned learning_priors.

| Piece | Notes |
|---|---|
| learning_priors cleanup + seed | Fixed a data bug (every prior was duplicated — 15 unique stored twice). Added 15 new source-tagged priors (12-1 momentum, low-vol, quality, earnings revisions, PEAD, credit spreads, ISM/PMI, real yields, VIX term structure, cycle rotation, cluster insider buying, breadth-over-depth, regime-first). 30 clean rows. |
| Migration 096 | learning_priors_history (belief-drift), unique(category,principle), macro_interpretations. All service-role-only. strategy_versions already had parent_version_id. |
| Migration 097 | Daily macro-read crons (us 9:30 ET, india 10:00 IST). |
| Phase 1 — Beliefs | /api/agent-mind/priors (GET/PATCH, owner-only) + Intelligence "Beliefs" tab. View/toggle/add priors; every change writes learning_priors_history + decision_journal. No LLM writes a belief. |
| Phase 2 — Brain | /api/agent-mind/brain (GET, owner-only) + Intelligence "Brain" tab: champion weights + why, belief drift, learner log, self-invented features, regime posture, track record, evidence-context banner (confidence shown next to N so small samples never read as authoritative). Pure DB reads. |
| Phase 3 — Macro read | /api/agent-mind/macro-read (GET owner / POST owner+cron) + Markets "What this means for your book" card. Cheap model over macro regime + holdings + macro priors; cached ≤1 call/day/market; advisory only, degrades to raw data if model down. |

Guardrails held: nothing here trades/sizes; no LLM mutates a belief; owner-gated; no hot-path market-data spend.

---

## ✅ Session 2026-07-07 (cont'd) — Codex review of Robinhood MCP: all 12 findings fixed

> External Codex adversarial review of the real-money path (CODEX_ROBINHOOD_MCP_REVIEW.md). Verdict: don't enable live orders until findings 1–8 fixed. All 12 + the AV note now fixed.

| # | Sev | Finding | Fix |
|---|---|---|---|
| F1 | CRIT | buildArgsFromSchema could emit valid-but-wrong order (esp. `amount`=dollars vs shares) | Dropped `amount` from qty aliases; enum-coerce side/type/tif to the schema's exact spelling (fail closed if unresolvable); verify `review_equity_order` preview ECHOES intended symbol/qty before place. |
| F2 | CRIT | robinhood_mcp_enabled not enforced on order path (only snapshot) | Enforced in Gateway (broker.id==robinhood_mcp) + inside the adapter (defense in depth). |
| F3 | CRIT | needsReconcile dropped → duplicate order after ambiguous timeout | Added to BrokerOrderResult; adapter preserves it; Gateway sets status `unknown_needs_reconcile` (HTTP 202); migration 095 adds that status to the active-order unique index + the friendly dup-check. |
| F4 | HIGH | risk-profile route only auth'd, not owner-gated | requireOwner() on PATCH + GET. |
| F5 | HIGH | SELL checked the read-only 965848641 snapshot, not the 605420660 trading account | For robinhood_mcp live sells, verify held qty via live MCP (robinhoodHeldQty) for the active account; fail closed if unverifiable. |
| F6 | HIGH | getActiveBroker silent fallback in order path | New getActiveBrokerForOrder (fail closed); Gateway uses it. |
| F7 | HIGH | refresh claimed CAS but did plain read/upsert | Real CAS on the refresh-token row's updated_at; loser re-reads; vaultSet now throws on write error. |
| F8 | HIGH | success with no order id treated as success | Live place with no parseable order id → needsReconcile, not success. |
| F9 | MED | allowlist lookups didn't filter by broker | Added .eq("broker", …) everywhere (adapter id robinhood_mcp → allowlist key 'robinhood'). |
| F10 | MED | OAuth state secret insecure fallback (cron/service-role/hardcoded) | Require OAUTH_STATE_SECRET ≥32 chars in prod; dev-only fallback; no cross-secret reuse. |
| F11 | MED | mcpRpc could misread partial/error responses as success | Require JSON-RPC id match + result present; treat tools/call result.isError===true as failure. |
| F12 | MED | guardOrderRequest cron bypass used plain `===` | Now verifyCronSecret (timing-safe, fail-closed). |
| note | LOW | AV budget counter failed OPEN on error | Now fails closed (serves cached) to protect the free-tier quota. |

Codex confirmed the notional-cap fallback (already fixed to fail closed) and the Kelly/trailing-stop/verifyCronSecret fixes are correct. Live orders still require: robinhood_mcp_enabled ON + all Gateway gates + human Approve/Send. First live order should be a tiny watched qty (no RH sandbox).

---

## ✅ Session 2026-07-07 (cont'd) — Robinhood MCP feature: unblocked parts (OAuth still pending)

> User approved building the parts of the Robinhood MCP feature that DON'T depend on Robinhood's real OAuth endpoints (which we don't have yet). The OAuth /login+/callback + live token acquisition + SDK transport stay stubbed until the user provides the endpoints/scopes. No order can reach Robinhood today: robinhood_mcp_enabled defaults off, isConfigured() is false with no token, and submitRobinhoodOrder() returns not-connected.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Migration 093 — scaffolding | Claude | 2026-07-07 | `broker_accounts` allowlist (service-role-only, seeded with today's two hardcoded RH accounts: 605420660=trading, 965848641=view_only); `strategy_config.active_account_us/india`, `live_account_source` (default claude_exec), `robinhood_mcp_enabled` (default FALSE), `max_order_notional`. |
| Migration 094 — dup-submit guard | Claude | 2026-07-07 | Partial unique index on broker_orders(proposal_id) WHERE active — hard backstop against the concurrent-double-click race. |
| Execution Gateway hardening (R6) | Claude | 2026-07-07 | app/api/broker/orders/route.ts now: requireOwner + guardOrderRequest (request-guards extended to read APP_BASE_URL so it works on Vercel), env must be explicit (no silent paper default), both-direction broker.envs check, checkKillSwitches at submit, fresh-quote notional cap (max_order_notional or 15% of live equity), price-drift re-check vs approval, sell-only-if-held, symbol/qty validation, fail-closed account-allowlist resolution. Benefits the existing Alpaca/Kite path too. |
| robinhood_mcp broker adapter (deterministic, stubbed) | Claude | 2026-07-07 | lib/robinhood-mcp.ts + lib/brokers/adapters/robinhood-mcp.ts + registry entry. Write path is a direct typed callTool sketch (R1: NO LLM ever) — currently returns not-connected. isConfigured()=hasRobinhoodToken() (false until OAuth stores a token). disconnectRobinhoodMcp() wipes locally regardless of remote reachability. Fail-closed account allowlist re-checked inside the adapter (last line before the wire). |
| Settings scaffolding | Claude | 2026-07-07 | Robinhood MCP card (status, Connect [disabled until oauth_ready], Disconnect, robinhood_mcp_enabled toggle, snapshot-source switch, US active-trading-account selector from the allowlist), + supporting owner-gated routes: /api/robinhood-mcp/status, /api/robinhood-mcp/disconnect, /api/broker-accounts. risk-profile PATCH/GET extended with the new fields (active_account_* validated against the allowlist server-side). |
| OAuth flow — UNBLOCKED & built | Claude | 2026-07-07 | User provided (and I verified against Robinhood's live well-known metadata) the real endpoints: auth https://robinhood.com/oauth, token https://api.robinhood.com/oauth2/token/, register https://agent.robinhood.com/oauth/trading/register, scope=internal, PKCE S256, public client (auth_method none), resource=…/mcp/trading. Built: dynamic client registration (RFC 7591), /api/robinhood-mcp/login (owner-gated, PKCE + HMAC-signed HttpOnly state cookie), /api/robinhood-mcp/callback (state verify + code exchange + vault token storage), refresh with expiry check. lib/robinhood-mcp.ts rewritten from stub to full OAuth + a deterministic MCP JSON-RPC client (initialize → tools/list → review_equity_order → place_equity_order), NO LLM in the write path. Arg schema discovered at runtime via tools/list; FAILS CLOSED if a required order field can't be mapped (no sandbox exists, so no guessing a real order). refresh-snapshot route now branches on live_account_source (cloud MCP writes the snapshot directly via service client, no loopback CRON_SECRET hop). oauth_ready=true; Connect button live. Still gated: robinhood_mcp_enabled default OFF + all Gateway checks + human Approve/Send. |

---

## ✅ Session 2026-07-07 — Security audit fixes + agent-system bug sweep

> Two parallel audits (security review of the Robinhood MCP feature vs. real code; agent-system + API-budget audit). Feature stays Draft/unapproved; these are the standalone bugs/vulnerabilities the audits surfaced in shipped code.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Vault + broker_orders RLS lockdown (migration 089) | Claude | 2026-07-07 | `api_key_vault` had a `USING(true)` policy for ALL roles + anon/authenticated write grants — anyone with the public anon key could overwrite/delete broker tokens without logging in. `broker_orders` had RLS disabled. Both now service-role-only. Applied live; non-breaking (all app access is service-client). |
| Owner-gated snapshot GET + open-redirect + timing-safe cron secret | Claude + agent | 2026-07-07 | `GET /api/live-account/snapshot` returned live equity/positions with NO auth → now `requireOwner()`. `/auth/callback` `next` param validated (blocked `?next=@evil.com` open redirect). New `verifyCronSecret()` (crypto.timingSafeEqual, fails closed on unset secret) applied across 25 cron routes. |
| Both Kelly sizing bugs | Claude | 2026-07-07 | paper-trade passed percent-scale caps into the fraction-based `lib/risk/sizing.ts` → every position pinned to the 2% floor once the calibrated model activated (conviction scaling dead). trader reimplemented Kelly with Thorp's `p/a−q/b` fed per-trade returns → leverage-scale numbers that always pegged the ceiling. Both now use the shared correct impl (payoff-ratio Kelly), caps as fractions, result scaled to percent. |
| AV free-tier budget: cache heavy fetchers + budget guard (migration 090) | Claude | 2026-07-07 | Four heaviest AV callers (INSIDER/OVERVIEW/DAILY_ADJUSTED/NEWS_SENTIMENT) bypassed the day-cache → ~60-100 calls/day vs the 25/day free budget, starving the scorer. Routed all through `avCachedFetch`; theme-scout's global feeds cached + its OVERVIEW check shares research's cache key (dedupe); removed theme-scout's free-text `topics=` no-op call. Added `av_budget` daily counter — stops spending real calls past the ceiling, serves cached instead. |
| Trailing-stop vs dynamic-stop conflict (migration 091) | Claude | 2026-07-07 | PositionMonitor trailed every stop at a hardcoded 7% and overwrote stop_loss each run, discarding the MAE-derived stop distance from fill. Now persists the initial stop (immutable, via trigger) and trails at the position's own distance. |
| Legacy trade_queue generator hardened | Claude | 2026-07-07 | `/api/agents/trade` (writes trade_queue, parallel to trade_proposals) lacked the kill-switch + owner gates the main trader has. Added both. Its approve path only emits a manual paste command (no autonomous execution). Full UI consolidation onto trade_proposals flagged as a separate architecture-gated change. |
| India learner + Kite holdings-first + wire india_screen_cache (migration 092) | Claude | 2026-07-07 | Learner was hardcoded `LEARN_MARKET="us"` — India never evolved. Now market is a per-run param (body/query), idempotency + run record scoped by market, new Friday `kairos-learner-india` cron passing `{"market":"india"}`. Research India block now pulls real Kite holdings (isHeld→SELL enabled) + dual-bucket candidates from the nightly india_screen_cache (was static first-8 NIFTY names). |

---

## ✅ Session 2026-07-06 (cont'd) — Mobile-responsive pass + per-market trading toggle

> User: whole app looked bad on mobile ("don't miss anything, remember same for future feature work") + wanted a per-market live-trading on/off separate from the existing Kite disconnect kill-switch (view holdings always, toggle auto-trading independently for US/India).

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Mobile-responsive: DashboardShell + global CSS | Claude | 2026-07-06 | `useIsMobile()` matchMedia hook + slide-in drawer nav (`DashboardShell.tsx`); global overflow-x safety net + table/img overflow rules in `globals.css`. |
| Mobile-responsive: all ~30 dashboard pages/components | Claude + parallel agents | 2026-07-06 | CSS-only fixes (grid `auto-fit/minmax`, `clamp()` padding, table `overflowX` wrappers, `flexWrap`) — no JS breakpoint logic per-page. Verified via `tsc`, `vitest` (86/86), clean `next build`. |
| Kite disconnect kill-switch | Claude | 2026-07-06 | `disconnectKite()` wipes local token even if Kite's revoke call fails/unreachable; Settings UI Disconnect button + note that revoking at kite.zerodha.com is the authoritative, app-independent kill switch. |
| Robinhood MCP integration — architecture draft only | Claude | 2026-07-06 | `features/robinhood-mcp-integration/FEATURE_ARCHITECTURE.md`, Status: Draft, unapproved, unimplemented. Coexists with (does not replace) the manual Claude-Code-paste flow; read-only account-snapshot scope only. |
| Migration 088 — per-market trading enable/disable | Claude | 2026-07-06 | `strategy_config.trading_enabled_us` / `trading_enabled_india` (both default true). Gated in `app/api/broker/orders/route.ts` for live orders only — reordered the check to run after `market` is resolved from the symbol, alongside the pre-existing global `trading_enabled`. Viewing holdings/balances was already market-agnostic and untouched. Settings → Agents now has an independent toggle pair, distinct from the Kite Disconnect kill-switch (this never revokes a credential, just pauses new live orders for that market). |

---

## ✅ Session 2026-07-06 (cont'd) — India-specific morning/evening email briefings (NSE-hour anchored)

> User asked whether the emailed morning/evening briefings fire separately for US vs India, matching each market's own open/close, like research/position-monitor already do.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Briefing route made market-aware | Claude | 2026-07-06 | `app/api/briefing/generate/route.ts` was 100% US-only and ET-anchored (hardcoded `paper_portfolio.market='us'`, SPY/QQQ/DIA/VIXY via Massive, no market param at all). Now accepts `market: "us"\|"india"` in the cron body: uses the market's own timezone (IST for India, no DST) for date/session logic, filters every market-scoped query (paper_portfolio/positions/signals/trades/runs), swaps the index snapshot to NIFTY/SENSEX via `fetchIndiaIndices()` (India indices are raw point levels, not $-priced ETPs, so no currency prefix), and threads currency (₹/$) through every dollar-formatted line in both the email HTML and the LLM's data context. India has no live-broker section (Kite live state isn't wired into this briefing) — that block is simply omitted for India rather than showing US Robinhood data mislabeled. |
| Migration 085 — briefings market column | Claude | 2026-07-06 | `briefings`/`newsletters` had no market column and a `(date,session)` unique constraint — would have silently clobbered India's brief against the same day's US one. Added `market`, changed the constraint to `(date,session,market)`. |
| Migration 086 — India briefing cron | Claude | 2026-07-06 | New `kairos-brief-morning-india` (9:50 AM IST, 20min after `kairos-research-india`) and `kairos-brief-evening-india` (4:30 PM IST, 45min after `kairos-position-monitor-india`/NSE close) — mirrors the existing US brief-morning/brief-evening pattern (fire after the relevant agent activity has landed, not on a fixed clock disconnected from it). |
| Position price source for India | Claude | 2026-07-06 | Found while wiring this: India position price enrichment fell back to `price_cache`, a US-only-populated table — India positions with no `current_price` set would always show "price unavailable". Now uses `fetchIndiaQuote()` (the same Yahoo source PaperTrader itself fills India orders from) when the market is India. |

---

## ✅ Session 2026-07-06 (cont'd) — Closed every remaining market-switcher gap: Agents currency (₹), Morning Briefing India section, remaining Decision Journal write sites

> User said "fix all" on the three remaining disclosed gaps from the prior entry.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Agents page currency (₹) | Claude | 2026-07-06 | Passed `market` down from the server page; `AgentsPage` now computes `currency = market === "india" ? "₹" : "$"` and every price display (NAV, cash, positions, trades, backtest rows) uses it. Live Robinhood trade proposals deliberately stay `$` — that account is US-only regardless of the switcher. Registry updated to "full". |
| Decision Journal — broker order/fill sites | Claude | 2026-07-06 | `app/api/broker/orders/route.ts` and `.../sync/route.ts` now tag `market` at insert time (trivially available: `market` var / `order.market`). Settings/risk-profile changes and cron-gap alerts remain genuinely global (not market-specific) — left untagged, documented as such rather than a bug. |
| Morning Briefing — India section | Claude | 2026-07-06 | `app/dashboard/page.tsx` now also fetches India's paper_portfolio/positions/pending-signals/recent-runs (cheap, unconditional). `DashboardHome` renders an "India Paper Portfolio" card (NAV/P&L/cash/positions/high-conviction signals/last research run) below the US hero, shown only when `profile.market_focus` enables India. Also fixed a real bug found while doing this: the page's `positions`/`recentTrades`/`recentRuns`/`recentSignals` queries were UNFILTERED by market, silently blending India data into what the US hero card presented as pure-US NAV/positions — now scoped to `market=us` to match `paperPortfolio`. |

Every dashboard page the switcher touches is now genuinely wired, or explicitly documented as intentionally single-market (Live Portfolio, India page) via the nav badge system from the prior entry.

---

## ✅ Session 2026-07-06 (cont'd) — Critical: kairos_call_agent overload ambiguity (most cron jobs failing), decision_journal type-mismatch bug, remaining market-switcher wiring

> User asked why the evening briefing didn't generate and pushed to finish wiring the remaining unwired pages (Research Journal mislabel, Agents, Decision Journal, Morning Briefing).

| Task | Agent | Completed | Notes |
|---|---|---|---|
| **CRITICAL: kairos_call_agent overload ambiguity** | Claude | 2026-07-06 | Two Postgres overloads of `kairos_call_agent` existed (an old 3-arg version with no timeout param, and the fixed 4-arg version) — any pg_cron call that didn't pass all 4 args explicitly failed with "function is not unique." Confirmed via `cron.job_run_details`: proposal-reminder, broker-sync, position-monitor, nav-snapshot, rescore, and brief-evening were failing on nearly every scheduled fire — this is why the evening briefing didn't generate. Dropped the redundant 3-arg overload live + migration 083. |
| **CRITICAL: decision_journal type-mismatch bug** | Claude | 2026-07-06 | Found while adding the market column: `signal_id`/`paper_trade_id` were typed `bigint` but `agent_signals.id`/`paper_trades.id` are `uuid` — every `paper_fill`/`paper_exit` insert (which pass the real uuid) has been silently failing since the table existed. Confirmed live: 0 of 7 ever-created rows had these populated. Fixed both column types + added `market` (backfilled via join) in migration 084, applied live. |
| Decision Journal market wiring | Claude | 2026-07-06 | `/api/journal` now accepts `?market=`, page wired to `useMarket()`. Write sites tagged with `market` at insert time where available (paper-trade, position-monitor, manual close, strategy promotion override, Kite orders — hardcoded `india`). A few entry types with no derivable market (settings changes, broker-order/cron-gap alerts) default to the US view. |
| Agents page — partial wiring | Claude | 2026-07-06 | Server component now reads the `mkt` cookie and filters signals/trades/positions/performance/runs by market. NOT marked "full" — ~15 price displays in the 1500-line client component still hardcode `$`, not yet currency-converted for India. Registry marked "partial" honestly rather than overclaiming. |
| Research Journal mislabel fix | Claude | 2026-07-06 | Was falling through to the home page's registry entry (which is `us-only knownGap`) because I forgot to add its own entry last turn — it actually already works for both markets via its own in-page picker. Added the missing entry. |
| Morning Briefing | — | Deferred | Needs actual new UI (India NAV/signal/activity sections), not just a data filter — banked as a follow-up rather than rushed. |

---

## ✅ Session 2026-07-06 (cont'd) — Market-switcher wiring gap, nav clarity badges, India cron realignment, India NSE status pill

> User asked why it's hard to tell from the UI which left-nav sections actually respect the US/India switcher, asked to fix any unwired ones, and separately asked whether India's agents fire at the right time relative to NSE market hours (raised alongside a concern about Windows cron double-firing pg_cron, which was also resolved this session — all 15 `\Kairos\` Windows Scheduler jobs disabled).

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Windows Task Scheduler decommission | Claude | 2026-07-06 | Found all 15 `\Kairos\` jobs still `Ready`, hitting `localhost:3000` — the exact routes pg_cron now hits in the cloud. Duplicate trades were already prevented by paper-trade's signal-claiming idempotency (shared DB), but duplicate LLM/API spend was real whenever a local dev server happened to be running. Disabled all 15 with user approval. |
| Market-switcher wiring audit | Claude | 2026-07-06 | Surveyed all ~20 dashboard routes: only 9 actually read `useMarket()` (Portfolio, Risk, Markets, Strategies, Calendar, Scanner, Backtest, Settings, Intelligence) despite the switcher's own tooltip claiming "across the app." Watchlist, Score Tracker, and Agent History wired to the global switcher this session (API + component changes, `lib/market-support.ts` registry corrected to stop overclaiming "full" support on Agents/Journal/Morning Briefing, which don't actually filter). |
| Nav market-scope badges | Claude | 2026-07-06 | Added a small flag/warning badge directly in the left-nav sidebar (`components/dashboard/DashboardShell.tsx`), reading the existing `lib/market-support.ts` registry — previously that info only existed in a footer badge at the bottom of each page's content, which is exactly why it was "hard to tell from the UI." Distinguishes intentional single-market pages (🇺🇸/🇮🇳 flag) from known gaps that should respect the switcher but don't yet (⚠ US only). |
| India NSE market-status pill | Claude | 2026-07-06 | Added a second status pill next to the existing US market-status pill (top bar), showing NSE open/closed/pre-open using IST hours (9:15 AM–3:30 PM) and the same fixed-date holiday list as the research cron's NSE gate. Shown only when India is enabled in `profile.market_focus`, mirroring `MarketSwitcher`'s own visibility rule. Both pills now explicitly flag-labeled (🇺🇸/🇮🇳) — previously the single pill had no country label at all. |
| India research cron timing fix | Claude | 2026-07-06 | Found `kairos-research-india` fired at 16:30 IST — 1hr AFTER NSE's 15:30 close — meaning India's research (score off latest candle) and its internally-chained paper-trade fill (fetch a "live" quote) both landed on the exact same closing print, no realistic decision-to-fill gap. The US equivalent fires pre-open (scores off yesterday's close) and its chained fill lands on a genuinely live post-open quote. Realigned India to fire at 9:30 AM IST (15min after NSE's 9:15 open) instead — still scores off yesterday's finalized close, but the chained fill now gets a real intraday quote. `position-monitor-india` (15min after close) was already correctly timed and left unchanged. See migration 082. |

---

## ✅ Session 2026-07-06 (cont'd) — Codex adversarial review fix pass: evidence semantics, shared scoring contract, Theme Scout, Kelly sizing, LearnerAgent evidence-binding

> User requested an independent LLM (Codex) audit of the core scoring/trading/learning loop after the ultra-review pass, worried that missing/rate-limited external data (Alpha Vantage, Yahoo, etc.) could silently corrupt research/learning signals. Verified each finding against current code + live schema (several of Codex's line-number claims referenced pre-Decision-41 code and were stale/false — noted below), then fixed every confirmed issue in the requested priority order. See **Decision 43**.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Sentiment/insider availability always-true bug | Claude | 2026-07-06 | `fetchSocialSentiment()` never returns null (even when both StockTwits and AV news fail) and `scoreInsider()` never returns null either — so `dataQuality.sentimentDataAvailable = !!socialResult` / `insiderDataAvailable = !!insiderResult` were always `true`, meaning a fully-failed fetch still counted as "available neutral evidence" in weight renormalization. Added a real `has_data`/`available` flag to each, threaded through `lib/data/scores.ts`. |
| India fundamentals false-positive availability | Claude | 2026-07-06 | `lib/india-data.ts`'s `fetchIndiaOverview()` always sets `ov.Symbol` on any quoteSummary hit, even with zero real fields populated — `!!avOverview?.Symbol` treated a totally sparse response as available. `scores.ts` now requires 2+ of the 5 real fundamental fields (`hasMinFundamentalFields()`) before marking fundamentals available, for both US and India. |
| Macro scoring read the wrong table | Claude | 2026-07-06 | `fetchMacroScore()` queried `macro_signals` for `danger_score`/`regime` — those columns live on `macro_regime` (migration 028); `macro_signals` is per-indicator rows with no such columns. Every query silently errored → macro was excluded from every single scoring run since Decision 41 shipped renormalization, meaning MacroSentinel's weekly regime assessment never actually influenced a live score. Fixed to query `macro_regime`. |
| Shared weighted-score contract | Claude | 2026-07-06 | New `lib/scoring/weighted-score.ts` (`computeWeightedAnalystScore`) — the exact renormalization logic previously inlined only in `lib/research-agent.ts`. Now also used by `lib/validation/engine.ts`'s `scoreRow`, fed by a new `availability_mask` column select in `lib/learning/dataset.ts`. Previously the Validation Engine coalesced missing scores to 50 with a fixed weight split — a challenger could pass/fail on a different objective than the one that runs live. Also fixed a drift bug: the `availability_mask` persisted to `decision_observations` was a SEPARATE computation from the `included` object that actually drove live weighting, and disagreed for ETFs — now the same object is reused for both. |
| Abstain on thin evidence | Claude | 2026-07-06 | `processSymbol()` now forces `direction: "neutral"` when fewer than 2 dimensions are included OR the LLM thesis JSON parse fails — previously a parse failure fell back to `analystScore >= threshold ? "long" : "neutral"`, which could open a long position backed by a single technical-only signal with no thesis. Exit signals on held positions (`isHeld && direction === "short"`) are explicitly exempted — CLAUDE.md's locked SELL-signal-on-holdings rule always wins. |
| Theme Scout: schema + ownership + ticker validation | Claude | 2026-07-06 | Backfilled migration 081 for watchlist columns (`source`/`theme`/`reason`/`auto_added`/`expires_at`/`updated_at`/etc.) that were live but never committed, and relaxed `user_id` to nullable to match the live schema. Theme Scout now sets `user_id` to the app's profile owner (previously null → the app-facing Watchlist API's dedupe-by-symbol workaround was masking the real bug). Added `tickerExists()` — every LLM-suggested or AV-mentioned candidate must now pass an Alpha Vantage OVERVIEW existence check before insertion; failures are reported as `quarantined` in the response instead of silently entering the watchlist. Upsert errors are now logged + alerted instead of swallowed. |
| Kelly no-edge sizing bug | Claude | 2026-07-06 | `lib/risk/sizing.ts`'s `positionSizePct()` clamped negative/zero Kelly (no edge) to the floor size instead of zero — a calibrated model saying "no edge here" could still open a real floor-sized position. Now returns 0 when `kellyFraction <= 0`; the floor only applies once there's a genuine positive edge. Updated `tests/sizing.test.ts` to assert the corrected behavior. |
| Finite-number guards in PaperTrader | Claude | 2026-07-06 | `app/api/agents/paper-trade/route.ts` — `sizedPct`, `fillPrice`, `maxSpend`, `qty`, `totalCost` are now explicitly checked with `Number.isFinite()` before the fill RPC; previously a NaN from an upstream model/config value passed every `<= 0` / `< 1` comparison silently (NaN comparisons are always false) and could have reached `execute_paper_fill` with a NaN qty. Also: added the 5 missing `max_*_exposure_pct`/`max_avg_pairwise_corr` columns to the initial `strategy_config` select (previously never fetched, so Portfolio Constructor limits always silently used hardcoded defaults); fail-closed on the legacy multi-step fallback path in `VERCEL_ENV=production` if `execute_paper_fill` is ever missing there; added a `dynamic_rr_unavailable` stage-event log when the MAE/MFE percentile lookup returns null. |
| LearnerAgent evidence-bound weight mutations | Claude | 2026-07-06 | `update_signal_weight` previously trusted the LLM's own `n_trades`/`confidence` arguments for its numeric gates, with nothing binding them to a specific `query_score_correlation` result. Extracted the correlation logic into a shared `computeScoreCorrelation()` helper; `update_signal_weight` now recomputes it server-side fresh for the target dimension and gates on that — refuses the mutation entirely if only the weaker `paper_trades_fallback` is available (ledger required), requires N≥10 from the ledger (not the LLM's claim), and requires the correlation's sign to agree with the direction of the proposed weight change. The LLM's own numbers are now logged for context only. |
| Findings verified as pre-existing/already-fixed or false alarm | Claude | 2026-07-06 | Theme Scout's `watchlist.user_id not null` claim was stale — live schema has it nullable (confirmed via `information_schema`); the real issue was ownership (fixed above), not a hard constraint violation. `execute_paper_fill` RPC is confirmed present live, so the legacy-fallback risk was theoretical (still hardened defensively). |

---

## ✅ Session 2026-07-06 (cont'd) — Cloud-cron migration, pg_net timeout fix, Posture/Goals spec

> Vercel deployed as a silent cron-trigger target; 21 `pg_cron` jobs in Supabase now fire every agent independent of the laptop. Posture/Goals spec built in full. See **Decision 38**.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Vercel deployment + Supabase `pg_cron` migration | Claude | 2026-07-06 | Repo deployed to Vercel (git-integration auto-deploy), Deployment Protection disabled, `CRON_SECRET` gate verified live. 21 cron jobs registered via `kairos_call_agent()` (vault-stored secret, never hardcoded). Includes `macro-sentinel`/`theme-scout` which had never been scheduled anywhere before. |
| pg_net timeout bug fix | Claude | 2026-07-06 | Default 5s pg_net timeout would've silently killed every LLM-backed cron call. Added `maxDuration` to 16 Vercel routes + configurable `timeout_ms` param on the Supabase helper function; 3 heaviest jobs bumped to 300s. |
| Posture/Goals spec (Decision 38) | Claude | 2026-07-06 | Part A: kill-switch + exit-hysteresis now scale per risk profile (resilient fallback to old hardcoded defaults). Part B: time-bound postures with auto-revert (`decision_journal` logged), checked in the research cron. Part C: `trading_goals` table (agent-unread by design) + `/api/goals` feasibility math + dashboard `GoalCard`. |
| Ops Calendar + Broker Registry + Model Freshness (Decision 39) | Claude | 2026-07-06 | 30-day agent calendar (top of dashboard, expected-set derived from actual `pg_cron` schedule since `market_focus` never existed). Broker adapter registry (`lib/brokers/registry.ts` + alpaca/kite adapters) — Gateway routes now go through it, sync loop handles multiple brokers. Weekly model-freshness check (`/api/models/check`, informational only, never auto-switches). |
| Research Journal (Decision 40) | Claude | 2026-07-06 | Daily per-symbol funnel trail (research → screener bucket → portfolio constructor → execution, each stage logged with a reason) + a longer-horizon Evolution tab. Found and fixed a dormant bug while building it: `decision_observations.signal_id` had been hardcoded null since Phase 1 shipped — the join key never actually worked. New `/dashboard/research-journal` page. |
| Quick fixes: manual paper-position close, seeded-trade tagging, sector-breadth bug | Claude | 2026-07-06 | Added a "Close Position" button (paper positions had agent-only exits, no manual override). Tagged the one seeded/demo META trade with a SEEDED badge so it's not mistaken for a real agent decision. Fixed `/api/markets/breadth` — failed quote fetches were defaulting to `changePct:0` and still populating the Pullers/Draggers display (only the A/D count excluded them), which is why every sector constituent showed "+0.000%". |
| Vercel type errors + false-pass local builds | Claude | 2026-07-06 | Two real TS errors (`.catch()` on a Supabase `PromiseLike`; a loose `string` not assignable to `BrokerAdapter`'s status union) had been failing every Vercel deploy since the Posture/Goals push — a stale `tsconfig.tsbuildinfo` incremental cache made local `npm run build` falsely report success both times. Fixed both, gitignored the buildinfo file, and confirmed with a clean `rm -rf .next` rebuild before trusting the result going forward. |
| `profiles.market_focus` column never existed | Claude | 2026-07-06 | The India market switcher (`MarketSwitcher`) had been silently hidden this whole time — it gates on `profiles.market_focus.includes("india")`, but that column didn't exist in the live schema at all (confirmed via `information_schema`), so it always defaulted to US-only. Added the column, set to `'US,India'` for the active profile. No app code change needed (`layout.tsx` already does `select("*")`). |
| Theme Scout ordering + watchlist expiry | Claude | 2026-07-06 | Theme Scout was firing AFTER research (fire-and-forget) — same-day theme discoveries weren't researched until the next day. Now awaited BEFORE `gatherSymbols()` (US-scoped only), `research/cron` `maxDuration` bumped 60→150s to cover it. Also: `gatherSymbols()` never filtered `watchlist.expires_at` — a 30-day-expired Theme Scout pick kept getting re-researched forever; now matches the same filter the Watchlist API already had. |
| Research Journal duplicate-symbol display | Claude | 2026-07-06 | Multiple real research runs the same day (scheduled + manual test triggers) each wrote a fresh `decision_observations` row, so the funnel showed flat duplicate rows. `/api/agents/research-journal` now groups by symbol, keeps the latest observation, shows a "×N runs" badge instead. |
| Sentiment scoring bug + weight renormalization (Decision 41) | Claude | 2026-07-06 | `scoreSentiment()` checked field names (`bullish_pct`) that never matched the real data shape (`stocktwits_bullish_pct`, `av_news_sentiment`) — sentiment was silently always neutral-50 even with strongly bullish real data. Fixed. Also: the weighted score now renormalizes across only applicable+available dimensions (ETFs no longer penalized for structurally-absent fundamental/insider data; unavailable macro no longer diluted at full fixed weight) instead of always applying the fixed 5-way split against fabricated neutral defaults. Applied weights recorded into `decision_observations.features.weighting`, surfaced in Research Journal. |
| Sidebar reorg + India nav clarity | Claude | 2026-07-06 | Regrouped the sidebar (Daily / Portfolio / Agents & Research / Discovery / Learn / Settings) now that it has ~25 items. Clarified that "India" is the India *live* Zerodha Kite view (parallel to "Live Portfolio", not a duplicate of Paper Portfolio, which already handles both markets via its own switcher) and relabeled/regrouped accordingly. |
| Ultra-review fix pass (Decision 42) | Claude | 2026-07-06 | 10-angle multi-agent adversarial review of the full session diff, prompted by the density of silent bugs already found earlier. Fixed in priority order: same-day kill-switch never actually fired (compared a not-yet-written "today" row); screener bucket ordering let momentum crowd out value candidates; an Alpaca order-status regression from tonight's own type fix; posture override silently clobbered by profile defaults; broker registry error-swallowing; Kite/India orders had zero reconciliation path; consolidated 3 duplicated risk-profile constant tables into `lib/risk-profiles.ts`; currency-blind win/loss classification (fixed `$0.5` band) replaced with a relative `±0.1%` band via `lib/trade-outcome.ts`; weight-renormalization zero-division edge case; manual-close qty-drift logging; `schedule.ts` days/time mismatch; mislabeled shadow "agreement %" renamed; and — the biggest structural gap — none of ~10 schema changes applied live via Supabase MCP this session had a committed migration file, backfilled as `supabase/migrations/072`-`080`. |

---

## ✅ Session 2026-07-06 (Learning-core Phase 3 — genome, feature registry, shadow decisions, regime features, governance rewiring)

> Completes the full learning-core roadmap (Phases 1–3 + all P0s + Execution Gateway paper-stage). See **Decision 37**.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Typed strategy genome | Claude | 2026-07-06 | Migration 063 (`strategy_versions.genome`, `agent_signals.genome_hash`) + `lib/validation/genome.ts` (hard-bounded validation, diff counting, hashing). Genome-less rows unaffected. |
| Feature registry + whitelisted compiler | Claude | 2026-07-06 | Migration 064 (`feature_registry`) + `lib/validation/feature-compiler.ts` (from-scratch tokenizer/parser/evaluator — `+ - * /`, `log/abs/min/max/lag` only, no eval/no dynamic code). New `propose_feature` learner tool. |
| Feature IC-check job | Claude | 2026-07-06 | `lib/validation/feature-check.ts` (Spearman rank-IC + Fisher-z significance, pure/tested) + `app/api/validation/feature-check` (weekly cron) — promotes proposed→quarantined→active, auto-retires decayed features. |
| Shadow decisions | Claude | 2026-07-06 | Migration 065 (`shadow_decisions`, extends `strategy_versions.state` with `shadow_paper`). ResearchAgent records what up to 3 shadow versions would decide alongside the champion's real decision — no fills, no cash. Off by default. |
| Regime features | Claude | 2026-07-06 | `lib/validation/regime.ts` (trend/vol-tercile vs SPY/^NSEI, pure/tested) appended to every observation's `features.regime`. No hard bull/bear switch. |
| Governance rewiring | Claude | 2026-07-06 | Learner auto-guard now trips on champion health (drawdown>15%/90d peak, calibration drift>0.25, data-availability<60%/10 obs) instead of a raw win-rate streak. Confirmed it only ever gated `update_signal_weight` — other tools unaffected. |
| 85 tests passing, tsc + build clean | Claude | 2026-07-06 | 5 new test files this session alone (genome, feature-compiler, feature-check, regime + existing suite). |

---

## ✅ Session 2026-07-06 (Execution Gateway — Alpaca paper orders + fixed a discovered Trade Queue bug)

> Built the paper-stage of the Execution Gateway (spec Part A) and, in the same change, fixed a pre-existing (empty-table, no real-data-loss) bug: the Trade Queue UI read a dead `trade_queue` table while Approve/Reject/the Gateway all use `trade_proposals`. See **Decision 36**.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Alpaca order adapter | Claude | 2026-07-06 | `lib/brokers/alpaca-orders.ts` — submit/get/cancel, reuses the existing vault-key pattern from `lib/brokers/alpaca.ts`. |
| broker_orders lifecycle + routes | Claude | 2026-07-06 | Migration 068. `POST /api/broker/orders` (human-click only, live gated on trading_enabled) + `/sync` (30-min cron, position reconciliation + alert). |
| Fixed trade_queue/trade_proposals mismatch | Claude | 2026-07-06 | Repointed the Smart Money page's query to the real table (`trade_proposals`) and the correct pending status (`pending_review`). Approve/Reject now actually functional; both tables confirmed empty in prod, so no real data was ever affected. See Decision 36. |
| "Send to Alpaca (paper)" UI | Claude | 2026-07-06 | Button on approved proposals in the Trade Queue history table. Confirm dialog, paper-env only from this UI. |
| system-map.json — GATEWAY node | Claude | 2026-07-06 | New node; REALORDER description clarified as Robinhood-specific. |

---

## ✅ Session 2026-07-06 (Learning-core Phase 2 — Validation Engine + calibrated Kelly sizing + transactional fill RPC, all verified live)

> Validated live via the reconnected Supabase MCP: migrations 061/062 applied, `execute_paper_fill` RPC tested end-to-end (disposable signal, all 5 writes landed atomically, then fully reversed). See **Decision 35** (Validation Engine + sizing) and **Decision 34** (transactional-fill RPC + the pre-existing signal_id bug it uncovered).

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Transactional paper-fill RPC | Claude | 2026-07-06 | `execute_paper_fill` (migration 071) — claim-reverify → event → trade → position → cash → signal-flip in ONE transaction, row-locked. Verified live end-to-end; falls back to the legacy multi-step JS sequence if absent. See Decision 34. |
| P0: cron-gap detector, vitest suite, Portfolio Constructor | Claude | 2026-07-06 | All three P0 app-improvements from the learning-core spec completed and verified (47 tests passing across 8 files by end of session). |
| Validation Engine | Claude | 2026-07-06 | `lib/validation/engine.ts` (migration 061 `validation_experiments`) — deterministic walk-forward replay, 1000-draw block bootstrap (seed 42), pass rule: p_improvement>=0.80, CI floor, n_effective>=12, >=3/5 folds won. See Decision 35. |
| Fail-closed promotion gate | Claude | 2026-07-06 | `promote_champion` now HTTP 412s without a passed validation experiment (journaled `force_unvalidated` override exists, not the default path). See Decision 35. |
| Calibrated P(win) + Kelly sizing | Claude | 2026-07-06 | `lib/validation/calibration.ts` (migration 062 `model_artifacts`) — logistic regression replaces raw analyst_score as the sizing input; half-Kelly via `lib/risk/sizing.ts`, capped at the flat position_size_pct. Dormant until 60+ matured observations/market. |
| Dynamic MAE/MFE R:R | Claude | 2026-07-06 | `lib/risk/percentiles.ts` — stop/target from the ledger's actual outcome-percentile distribution, replacing the fixed 7%/20% profile constants. Signal-provided values always win. |
| Learner auto-fires validation | Claude | 2026-07-06 | `update_signal_weight` fires `/api/validation/run` the moment a challenger is created — evidence is usually ready before a human looks at the Strategy Registry. |
| Weekly fit-calibration cron | Claude | 2026-07-06 | New `app/api/validation/fit-calibration` route, Fridays 4:45 PM ET (before the 5 PM learner). |
| system-map.json — VALIDATE node | Claude | 2026-07-06 | New node between CHALLENGER and PROMOTE; TRADER + PROMOTE descriptions updated to reflect the gate + Kelly sizing. |

---

## ✅ Session 2026-07-06 (Supabase MCP reconnected — migrations applied, critical fill-event bug fixed)

> Reconnected Supabase MCP gave direct schema access for the first time in several sessions. Applied all pending migrations (060, 069) and one urgent live fix: **`paper_order_events.signal_id` was `bigint` while `agent_signals.id`/`paper_trades.signal_id` are `uuid`** — every paper fill's order-event insert had been failing since migration 034 (confirmed: zero rows ever in `paper_order_events`). Fixed live (migration 070, lossless — table was empty) and verified end-to-end: restarted the stale production server, re-ran ResearchAgent, confirmed `decision_observations` now writes real per-candidate feature rows. See **Decision 34**.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Applied migration 060 (observation_labels) | Claude | 2026-07-06 | Previously blocked by Supabase SQL-editor Redis/RLS-dialog issues; applied directly via reconnected MCP. |
| Applied migration 069 (portfolio_limits) | Claude | 2026-07-06 | `strategy_config` gains max_gross/sector/name_exposure_pct, max_portfolio_vol_pct, max_avg_pairwise_corr — Portfolio Constructor limits. |
| Fixed paper_order_events.signal_id type bug | Claude | 2026-07-06 | Migration 070. Long-standing bug (predates this session) silently failing every fill's audit-event write. See Decision 34. |
| Verified end-to-end on live DB | Claude | 2026-07-06 | Restarted stale `next start` server (was serving a pre-session build), re-triggered research, confirmed decision_observations populates with real feature blobs (5 dims × N candidates per run). |
| Confirmed migrations 057/058 already live | Claude | 2026-07-06 | Multi-market + India screen cache both confirmed applied from earlier sessions. |

---

## ✅ Session 2026-07-06 (Learning-core Phase 1 — decision ledger + matured horizon labels)

> An independent architecture review (Codex) found LearnerAgent's dataset statistically untrustworthy: signal→trade join by symbol (collision-prone), label = policy P&L on filled-longs-only (selection bias, mixes alpha with beta/holding-time/exits), no valid out-of-sample evaluation. This is the keystone fix everything else (validation engine, calibrated sizing, genome, shadow A/B — see `features/learning-core/`) is built on. See **Decision 33**.
> **⚠️ OPEN ITEM: migrations `059_decision_observations.sql` + `060_observation_labels.sql` must be applied MANUALLY in the Supabase SQL editor** — Supabase MCP permission-denied this session. Everything is guarded/additive: the app behaves byte-for-byte unchanged until they land, then the ledger starts accruing automatically.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Migrations 059/060 — decision ledger + labels | Claude | 2026-07-06 | `decision_observations` (append-only via trigger; one row per scored candidate, filled or rejected — raw `computeScores().evidence`, availability mask, weights used, score, action) + `observation_labels` (forward 2/5/10/20-trading-day `fwd_return`/`benchmark_neutral_return`/MAE/MFE, written only after horizon maturity). **NOT auto-applied — user must run both in the Supabase SQL editor.** See Decision 33. |
| ResearchAgent — observation write | Claude | 2026-07-06 | `lib/research-agent.ts` writes a `decision_observations` row for every scored candidate (fail-soft if 059 absent). Captures the full raw feature blob at zero refactor cost — future-proofs Phase 3 feature discovery. See Decision 33. |
| Label-maturation cron | Claude | 2026-07-06 | New `app/api/agents/label-maturation/route.ts` (nightly, 6:00 PM ET) matures each horizon once enough calendar time has passed; US prices from `price_cache`, India from `fetchIndiaCandles`; benchmark = SPY (US) / `^NSEI` (India); 10bps cost haircut on `fwd_return`. Registered in `run-agents.ps1` + `register-tasks.ps1`. See Decision 33. |
| Walk-forward dataset builder | Claude | 2026-07-06 | `lib/learning/dataset.ts` — `loadLabeledDataset` (ledger×labels join) + `walkForwardFolds` (pure function: purge = drop train rows whose label window overlaps the test window; embargo = skip a horizon's worth of time after each test window). Read-only; Phase 2's validation engine consumes it. See Decision 33. |
| LearnerAgent — ledger-first correlation + personal-history quarantine | Claude | 2026-07-06 | `query_score_correlation` now reads the ledger FIRST (all scored candidates, horizon-aligned, benchmark-neutral — not just fills/policy-P&L), tagged `source: "observation_ledger"` with an explicit INTERIM caveat; falls back to the legacy paper-trades path (now correctly joined by `signal_id`, not symbol) while the ledger is thin. `query_trade_decisions`/`semantic_search_decisions` (10yr personal history) now return `role: "behavioral_evidence_only"` — cannot satisfy `n_trades` or justify `update_signal_weight`. System prompt updated to state this explicitly. See Decision 33. |
| system-map.json — LEDGER node | Claude | 2026-07-06 | New `LEDGER` node (RESEARCH → LEDGER → LEARNER) documenting the ledger's role as the ground truth for the learning/evolution roadmap. See Decision 33. |

---

## ✅ Session 2026-07-05 (Phase 5 — India parity: global switcher + support registry + direct NSE feeds)

> India goes from paper-trading/self-learning (Phase 4) to **first-class across the whole dashboard**, behind a global market switcher, with an honest per-page coverage badge. Direct NSE feeds lift the two remaining free-data ceilings (full-market scan + India insider/options), failing soft to Yahoo/NIFTY-100. See **Decision 32**.
> **⚠️ OPEN ITEM: migration `058_india_screen_cache.sql` must be applied MANUALLY in the Supabase SQL editor** — Supabase MCP was permission-denied this session (`057` already applied by the user). Guarded code degrades to US-only until 058 lands.
> **⚠️ OPEN ITEM: NSE feeds may be geo-blocked from a US IP** — `lib/nse-data.ts` fails soft, so full-market scan + India insider/options degrade to their Yahoo/NIFTY-100 fallback with an honest note when NSE is unreachable.
>
> **Follow-up (2026-07-05):** the four remaining **partial** India panels were brought to **full** parity — Markets (real sector heatmap `fetchIndiaSectors` + NIFTY-50 breadth), Risk Analytics (real beta-vs-NIFTY, 1y daily-candle regression; `computeRiskMetrics` now async), Strategies (real India fit-scores from `signal_score_history` market='india'), Earnings (market-wide NSE results calendar `fetchNseEarnings`, Yahoo per-symbol fallback). New adapters: `fetchIndiaSectors` (`lib/india-data.ts`), `fetchNseEarnings` (`lib/nse-data.ts`); `market-support.ts` flipped all four to `full`. Genuine remaining US-only bits: Markets TradingView/macro-sentinel tiles, Strategies Algo Library; NSE feeds may geo-block from a US IP (graceful fallback). See Decision 32.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Global market switcher + per-page support footer | Claude | 2026-07-05 | `lib/market-context.tsx` (`MarketProvider`/`useMarket()` → `us\|india`, persisted to `localStorage` + `mkt` cookie) in the `DashboardShell` header, **hidden unless `market_focus` includes India**; server pages read the `mkt` cookie. `lib/market-support.ts` maps route → `{level: full\|partial\|us-only\|india-only, note}` as the single source of truth → a coverage badge at the bottom of every page. See Decision 32. |
| Markets panel — India | Claude | 2026-07-05 | India via Yahoo: NIFTY / SENSEX / BankNifty / India-VIX, plus a real sector heatmap (10 NSE sector indices via `fetchIndiaSectors`) + market breadth (NIFTY-50 advancers/decliners). Level: **full** (upgraded from indices-only 2026-07-05; TradingView/macro-sentinel tiles remain US-only). See Decision 32. |
| Risk Analytics panel — India | Claude | 2026-07-05 | Per-₹ book, VaR vs NIFTY, plus real portfolio **beta vs NIFTY** (1y daily-candle covariance/variance regression, value-weighted; `computeRiskMetrics` now async). Level: **full** (upgraded from partial 2026-07-05; was "beta coming soon"). See Decision 32. |
| Backtest panel — India | Claude | 2026-07-05 | Yahoo `.NS` candles, alpha vs NIFTY. Level: **full**. See Decision 32. |
| Scanner panel — India | Claude | 2026-07-05 | Full NSE market via nightly cache; NIFTY-100 live fallback. Level: **full**. See Decision 32. |
| Strategies panel — India | Claude | 2026-07-05 | Real India **fit-scores** computed from its signals' dimension scores (`signal_score_history` market='india'). Level: **full** (upgraded from partial 2026-07-05; was empty "US only" state; Algo Library remains US-only). See Decision 32. |
| Earnings panel — India | Claude | 2026-07-05 | Market-wide NSE results calendar (`fetchNseEarnings` via NSE event-calendar) with per-symbol Yahoo fallback. Level: **full** (upgraded from partial/tracked-names-only 2026-07-05). See Decision 32. |
| Smart Money panel — India | Claude | 2026-07-05 | Signals + trade queue both markets; India insider + option-chain PCR/OI live from NSE. Level: **full**. See Decision 32. |
| NSE direct feed adapter | Claude | 2026-07-05 | `lib/nse-data.ts` — cookie-handshake adapter for NSE's free JSON: full equity list (`EQUITY_L.csv`), insider (`corporates-pit`), option chain (`option-chain-indices`/`option-chain-equities`). **This lifted the two earlier ceilings** (full-market scan + India insider/options). Fails soft (NSE geo-throttles some non-India IPs) → callers fall back to Yahoo/NIFTY-100 with an honest note. See Decision 32. |
| Scanner cache + migration 058 | Claude | 2026-07-05 | Migration `058_india_screen_cache.sql` (new table) + nightly cron `POST /api/scan/india/refresh` scores the full NSE list in 600-name oldest-first slices; Scanner reads the cache, falls back to live NIFTY-100. **NOT auto-applied — user must run 058 in the Supabase SQL editor.** See Decision 32. |
| Market-scoped agents + India crons | Claude | 2026-07-05 | `research`/`paper-trade`/`position-monitor` accept `?market=us\|india`; US 9 AM tasks pinned to `?market=us` (no longer double-process India). India Task Scheduler tasks (PC clock = ET, all post-NSE-close 15:30 IST = 06:00 ET): scan-india-refresh 5:30 AM, research-india 6:15 AM, position-monitor-india 6:35 AM. See `scripts/run-agents.ps1` + `scripts/register-tasks.ps1`. See Decision 32. |
| Guarded rollout + system-map.json | Claude | 2026-07-05 | Pre-058 (missing column/table) every India-parity path degrades to US-only, never 500s. `system-map.json` updated with NSE nodes (full equity list, insider, option chain) feeding the scanner cache + Smart Money. See Decision 32. |

---

## ✅ Session 2026-07-05 (Phase 4 — multi-market learning: per-currency pools + per-market champions)

> Market is now a **tag** (us | india), not a fork — one app, panels filter by market, currencies NEVER summed. Supersedes Decision 29 (India was score-only): India now paper-trades in its own ₹ pool, closing the India learning loop. See **Decision 31**.
> **⚠️ OPEN ITEM: migration `057_multi_market.sql` must be applied MANUALLY in the Supabase SQL editor** — Supabase MCP was permission-denied this session (no psql/DATABASE_URL). Guarded code runs unchanged until 057 lands; India activates automatically once the `market` column + ₹ pool row exist.

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Migration 057 — market as a tag across the paper stack | Claude | 2026-07-05 | `market` column added to `paper_portfolio`/`paper_positions`/`paper_trades`/`paper_performance`/`agent_signals`/`signal_score_history`; `paper_performance` unique key `(date)` → `(date, market)` so each market keeps its own NAV curve. New India ₹ pool seeded at ₹1,000,000; `strategy_versions` gains `market` and India is seeded as a CLONE of the US champion (prior). **NOT auto-applied — user must run it in the Supabase SQL editor.** See Decision 31. |
| PaperTrader — per-currency fills | Claude | 2026-07-05 | `app/api/agents/paper-trade/route.ts` fills EACH signal into its market's pool in native currency: US via `getQuote` (AV/Robinhood USD), India via free Yahoo `.NS` (INR). Sizing = `position_size_pct` of THAT pool's cash. India now produces closed outcomes → **closes the India learning loop** (previously scored but never paper-traded). See Decision 31. |
| PositionMonitor — per-market exits | Claude | 2026-07-05 | `app/api/agents/position-monitor/route.ts` monitors/exits per market in native currency (India prices via Yahoo), crediting each close back to its own pool. See Decision 31. |
| LearnerAgent — per-market champion weights | Claude | 2026-07-05 | `app/api/agents/learner/route.ts` analyzes ONE market's cohort per run (US today) and proposes challengers ONLY for that market's champion — a bad India run can never shift US scoring. India diverges from its US-clone prior once it clears the same 10+ closed-trade phase gate. See Decision 31. |
| ResearchAgent — reads market-matched champion | Claude | 2026-07-05 | `lib/research-agent.ts` reads the champion weights for the symbol's market rather than a single global champion. See Decision 31. |
| Settings — `market_focus` trimmed + non-destructive gate | Claude | 2026-07-05 | `market_focus` reduced to US + India only (Europe/Asia/Crypto/Global removed as noise). Toggle is NON-destructive: India ON → NIFTY scoring + ₹ fills + India learning cohort; India OFF → stops NEW India research/fills but KEEPS open India positions monitored-to-close + all history/weights (re-enable resumes). Real Kite holdings/execution unaffected by the toggle. See Decision 31. |
| Portfolio UI — market selector | Claude | 2026-07-05 | Portfolio/paper surfaces gain a per-market selector so US ($) and India (₹) NAV curves and positions are viewed independently and never blended into one number. See Decision 31. |
| Guarded rollout + system-map.json | Claude | 2026-07-05 | Every path is pre-057-safe: with no `market` column / single pool, behavior is byte-for-byte the old US-only app. `system-map.json` updated to split the paper pool + learner per market. See Decision 31. |

---

## ✅ Session 2026-07-05 (India — Zerodha Kite + Yahoo multi-market integration)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Phase 1 — Kite auth (daily one-click login) | Claude | 2026-07-05 | `lib/kite.ts`, `app/api/kite/login\|callback\|status`. Kite Connect v3: login → `request_token` → SHA256-checksum exchange → `access_token` stored in `api_key_vault` as `KITE_ACCESS_TOKEN`, treated as expired if not generated today (Kite tokens expire 6 AM next day, SEBI rule). Verified live — real `/user/profile` returns the user's name. Settings → Agents shows a "Zerodha Kite · India" connection card. See Decision 30. |
| Phase 2 — India scoring on free Yahoo data | Claude | 2026-07-05 | `lib/india-data.ts`, `lib/india-universe.ts`, `research-agent.ts`, paper-trade route. Indian NSE (`.NS`) stocks run the SAME 5-dimension pipeline as US, but data is FREE Yahoo Finance (Kite Personal tier has no market data) — chart endpoint for price+candles (no auth), cookie+crumb `quoteSummary` for fundamentals, mapped into the AV-OVERVIEW shape the scorer expects. Candidates from a static NIFTY-50 list. US-only inputs (social/options/insider) skipped → neutral baseline, flagged in score-detail. Wired off `profiles.market_focus` including "India". Verified: RELIANCE.NS scored on real Yahoo fundamentals (P/E 21.85, ROE 9.1%, rev +12.5% → fundamental 73) over 124 real candles. **India is scored + tracked but NOT paper-traded** — INR pricing would corrupt the single-USD paper pool; `PaperTrader` excludes `asset_class="india"`. See Decisions 28, 29. |
| Phase 3 — real Kite execution + holdings | Claude | 2026-07-05 | `lib/kite.ts` additions, `app/api/kite/portfolio`, `app/api/kite/order`, `app/dashboard/india` page + nav. Real NSE/BSE holdings read (verified: 5 real INR holdings from the live account) and real order placement (`POST /orders/regular`, product `CNC`). Human-in-the-loop safety: authenticated-user-only (never cron/agent), requires explicit `confirm:true`, writes a `decision_journal` audit row; `/dashboard/india` uses a two-step confirm with a "REAL MONEY" warning that never fires on first click. Reads/orders degrade to a "reconnect" state when the daily token is stale. See Decision 30. |
| system-map.json + docs updated for India | Claude | 2026-07-05 | Added YAHOO/INDIA/KITE nodes to `system-map.json`; India / multi-market section in ARCHITECTURE.md; Decisions 28–30 in PROJECT_DECISIONS.md. Recorded data-source reality: US = Alpha Vantage + FinancialDatasets + Massive; India = free Yahoo (`.NS`) for data + Zerodha Kite for execution/holdings; no direct non-US equity beyond India. |

---

## ✅ Session 2026-07-05 (closed-loop learning, score history, exit de-confliction, Langfuse agent-loop tracing)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Closed-loop learning — ResearchAgent consumes champion weights | Claude | 2026-07-05 | `processSymbol` in `lib/research-agent.ts` now reads the promoted champion's `weights_snapshot` first (normalizing both key formats — seed `{fundamental:0.3}` vs challenger `{fundamental_weight:0.3}`), falling back to static `PROFILE_WEIGHTS` then `signal_weights` only when no champion is promoted. Loop was OPEN (promoted weights were never read); now CLOSED. `research_packets.raw_data` records `_using_champion_weights`. See Decision 24. |
| Score history — `signal_score_history` table + ScoreTrajectory | Claude | 2026-07-05 | Migration 054: append-only per-symbol score history (analyst_score + 5 dimensions, direction, source, created_at; RLS + `(symbol, created_at desc)` index; never mutated after insert). ResearchAgent appends best-effort per score (no-ops until migration applied) and injects a `SCORE TREND` note into the thesis prompt. New `GET /api/charts/score-history?symbol=X` feeds the symbol-detail chart (previously starved of data). PRD-specced, never built. See Decision 25. |
| LearnerAgent Phase B backstop de-confliction | Claude | 2026-07-05 | Phase A (smart `llm_exit` re-score) and Phase B (blunt >7-day time cutoff) raced; crude Phase B usually won. Phase B now skips any position already carrying the `llm_exit` flag and its cutoff moves 7 → 14 days, making it a last-resort backstop. `app/api/agents/learner/route.ts`. See Decision 26. |
| Langfuse tracing extended to `runAgentLoop` | Claude | 2026-07-05 | The multi-step tool-calling loop (LearnerAgent, MentorAgent) was invisible in Langfuse (only `llm_call_log`); now wrapped in a Langfuse trace/generation span (system prompt in, final text out, tokens, cost, tool-call trail as metadata). Extends Decision 15. LangChain/LangGraph still unused — loop stays hand-rolled against Anthropic/DeepSeek SDKs. See Decision 27. |

---

## ✅ Session 2026-07-04 (late — bug sweep: sector chart, briefing, live account, paper prices, privacy mode)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Sector chart pagination fix + Massive 500-bar cap discovery | Claude | 2026-07-04 | `bc07c7a` — `next_url` wasn't followed on 1Y+ periods; fixed, then found a real provider limit: Massive free tier caps aggs responses at ~500 bars, no pagination beyond that |
| Sector chart replaced with real TradingView widget | Claude | 2026-07-04 | `77f371f` (Symbol Overview embed — didn't hydrate reliably) → `9f81fd5` (final: reused `TradingViewChart` tv.js Advanced Chart component from symbol detail page, tab switcher across 11 sector ETFs). Removed `components/charts/SectorLineChart.tsx` + `app/api/charts/sector-history/route.ts`. See Decision 21. |
| Weekend briefing recap | Claude | 2026-07-04 | `909bcc4` — weekend-specific editor's-note prompt synthesizing last 7 days + week ahead, replacing the bland "nothing to do" daily prompt |
| Newsletter history wiring | Claude | 2026-07-04 | `909bcc4` — `sendBriefingEmail` now also inserts into `newsletters` table on send; Intelligence → Newsletter tab was always empty before this |
| Market Synthesis cache-poisoning fix | Claude | 2026-07-04 | `909bcc4` — only cache synthesis result to `briefings` on success, not on transient Massive failure |
| Live Robinhood account $0/$0 fix | Claude | 2026-07-04 | `359b2c6` — upsert (not insert) on `live_account_snapshots`; added missing `.eq("account_id", "965848641")` filter everywhere reads lacked it; verified against real Robinhood app |
| Stale paper position prices fix (META stuck at entry price) | Claude | 2026-07-04 | `9165958` — `position-monitor` + `learner` routes queried nonexistent `closed_at` column, silently no-op'd every run since written; fixed queries, fixed `opened_at` column name, fixed stray polygon.io endpoint, rewrote close logic to match real schema (delete `paper_positions` row, close matching `paper_trades` row) |
| Alpha Vantage day-cache wired into batch quotes | Claude | 2026-07-04 | Same commit `9165958` — `getBatchQuotes`/`fetchAVQuote` were uncached, burning the 25/day AV quota on every Live Portfolio load |
| Live Portfolio false "-100% total loss" fix | Claude | 2026-07-04 | Same commit `9165958` — `q?.price ?? fallback` never triggered on explicit `price: 0`; now falls back to avg cost honestly |
| Briefing "Learning Log" query fix | Claude | 2026-07-04 | Same commit `9165958` — was querying nonexistent columns on `learning_log` (that table is the learner's own weight-mutation audit log); switched to querying recently-closed `paper_trades` |
| Privacy Mode (new feature) | Claude | 2026-07-04 | Eye-icon toggle masks live-account dollar figures on Dashboard home + Live Portfolio, default-hidden, resets on remount; master switch in Settings → Preferences (localStorage). `components/dashboard/PrivacyMask.tsx`. See Decision 22. **Uncommitted as of this entry.** |
| execClaude/MCP tool-calling architecture audit | Claude | 2026-07-04 | **NOT FIXED — flagged only.** `execClaude` cannot call MCP tools (no API key, no MCP config); every "tool call" it makes is trusted text output. Found in `research-agent.ts` screener, `mentor/evaluate`, and — highest severity — the real-money order paths `agents/trader` + `agents/trade/approve`. Requires explicit user sign-off before fixing. See Decision 23 and ARCHITECTURE.md "Known Architecture Risk" section. |
| ARCHITECTURE.md dashboard nav map | Claude | 2026-07-04 | Added full nav-item-by-nav-item map (path, what it shows, backing API/tables) so an external reviewer can test every page against documented behavior |

---

## ✅ Session 2026-07-01 (latest — Kairos rename + wiring)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Platform rename FinanceOS → Kairos | Claude | 2026-07-01 | layout.tsx title, package.json, DashboardShell sidebar brand + tagline "Right signal. Right moment." |
| BOM + encoding corruption fix | Claude | 2026-07-01 | PS5.1 corruption fixed across 14+ files; curly quotes, em dashes, emoji sequences all cleaned; build restored clean |
| market_focus wired to ResearchAgent | Claude | 2026-07-01 | `gatherSymbols()` queries profiles.market_focus; non-US regions append region ETFs (India/Europe/Asia/Crypto/Global); marketFocus passed to thesis LLM prompt |
| Learner schedule: weekly (Fridays only) | Claude | 2026-07-01 | Cron-triggered learner now skips Mon–Thu; only runs Fri 5 PM; manual triggers unrestricted |
| Cron script updated: trader + schedule | Claude | 2026-07-01 | Added `trader` endpoint; corrected schedule comments (08:00 brief → 09:00 research → 09:45 trader → 16:15 pos-monitor → 16:30 brief → 17:00 nav → Fri learner) |
| market_focus multi-select chip UI | Claude | 2026-07-01 | Settings page: chip buttons US/India/Europe/Asia/Crypto/Global; comma-separated text in DB |
| Weekend + holiday skip in research cron | Claude | 2026-07-01 | research/cron and learner routes skip weekends + 2026 US holidays |
| Newsletter wired: EDGAR, proposals, weights | Claude | 2026-07-01 | 3 new data queries + 3 new email sections; deployed as v4 |
| ARCHITECTURE.md + WORK_LOG updated | Claude | 2026-07-01 | Full session 2026-07-01 documented |

---

## ⚠️ Known Pending

| Item | Priority | Notes |
|---|---|---|
| Server restart required | HIGH | Running `npm start` with old build. `Ctrl+C` then `npm start` to apply Kairos rename + all July 2026 changes |
| TraderAgent → Robinhood place_equity_order wire | HIGH | Approve button in SmartMoney updates DB status but does NOT call `place_equity_order` on account 605420650 |
| InfoTooltip wiring across dashboard pages | MED | `components/dashboard/InfoTooltip.tsx` exists but not wired to individual cards |
| Schedule: Task Scheduler tasks need creating | MED | Windows Task Scheduler tasks documented in `scripts/run-agents.ps1` but not yet created as scheduled tasks |

---

## ✅ Session 2026-07-01 (continued)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Apply migration 035 — evidence_records | Vaibhav + Claude | 2026-07-01 | Applied. evidence_records (immutable), corporate_actions, macro_signals (vintage_at, indicators_json) |
| Apply migration 036 — strategy_registry | Vaibhav + Claude | 2026-07-01 | Applied. strategy_versions, experiment_runs, agent_signals←version_id, paper_performance←spy_nav/alpha; seeds v1.0.0 champion |
| Apply migration 037 — trader_proposals | Vaibhav + Claude | 2026-07-01 | Applied. trade_proposals (HARDCODED 605420660), decision_journal |
| SEC EDGAR Form 4 insider trades | Claude | 2026-07-01 | `/api/markets/edgar-insiders` — SEC.gov CIK lookup + Form 4 XML parse; writes notable buys to evidence_records; SmartMoneyPage "Form 4 (EDGAR)" tab with lazy-load table |
| knowledge/event-patterns/ population | Claude | 2026-07-01 | Created `event-patterns/macro-events.md` (Fed/CPI/NFP/ISM/auctions + agent scoring adjustments), `event-patterns/earnings-patterns.md` (PEAD/SUE/red flags/sector patterns), `signal-library/proven-signals.md` (10 signals + anti-signals + correlation matrix); KNOWLEDGE_INDEX updated |

---

## ✅ Session 2026-07-01 (latest)

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Phase 0: `lib/data/quotes.ts` — deterministic quote adapter | Claude | 2026-07-01 | AV GLOBAL_QUOTE → price_cache fallback; freshness/stale detection; `computeFillPrice` (ask + 0.05% slippage) |
| Phase 0: `lib/data/technicals.ts` — RSI/EMA from candles | Claude | 2026-07-01 | Pure-math RSI(14), EMA(20/50) from OHLCV; `scoreTechnicals()` → 0-100 |
| Phase 0: `lib/data/scores.ts` — `computeScores()` | Claude | 2026-07-01 | All 5 scores deterministic: fundamental from AV OVERVIEW, technical from candles, sentiment from social, macro from macro_signals table, insider from AV transactions |
| Phase 0: `lib/data/evidence.ts` — evidence write helpers | Claude | 2026-07-01 | `writeEvidence`, `writeBatchEvidence`; SOURCE_TIERS map; fire-and-forget inserts to evidence_records |
| Phase 0: Migration 034 — paper_order_events | Claude + Vaibhav | 2026-07-01 | **Applied.** Append-only immutable event log; UPDATE/DELETE blocked by trigger; price provenance columns on paper_trades |
| Phase 0: `processSymbol` rewrite in research-agent | Claude | 2026-07-01 | LLM no longer generates scores; fetches AV OVERVIEW + candles → computeScores() → LLM writes thesis+direction only (512 tokens, Groq) |
| Phase 0: paper-trade route price upgrade | Claude | 2026-07-01 | Replaces execClaude/MCP price fetch with `getQuote()` + `computeFillPrice()`; writes immutable fill event to paper_order_events; SPY benchmark alpha tracking; decision journal entries |
| Phase 1: `lib/data/evidence.ts` + Migration 035 — evidence_records | Claude | 2026-07-01 | Migration **NOT YET APPLIED**. evidence_records table (append-only immutable); corporate_actions table; macro_signals altered (vintage_at, indicators_json) |
| Phase 1: `/api/agents/corporate-actions` — splits/dividends sync | Claude | 2026-07-01 | AV SPLITS + DIVIDENDS for held + watchlist symbols; upserts corporate_actions; GET filters by symbol/type/since |
| Phase 2: Migration 036 — strategy_registry | Claude | 2026-07-01 | **NOT YET APPLIED.** strategy_versions table; experiment_runs table; agent_signals ← strategy_version_id; paper_performance ← spy_nav/spy_return_pct/alpha_pct; seeds v1.0.0 Phase0-Baseline as champion |
| Phase 2: `/api/agents/backtest` — JS backtest engine | Claude | 2026-07-01 | Replays agent_signals vs price_cache candles; eligibility gate (Sharpe≥0.5, win_rate≥40%, drawdown<25%, min 20 trades, expectancy>0); persists to experiment_runs; SPY alpha |
| Phase 2: `/api/strategies/versions` — champion/challenger governance | Claude | 2026-07-01 | GET: list versions + nested runs; POST: promote_champion, retire, reject, or create new version |
| Phase 4: `/api/journal` — decision journal CRUD | Claude | 2026-07-01 | GET: filter by symbol/type/resolved; POST: create entry or resolve with outcome; links signal→fill→outcome |
| Phase 5: Migration 037 — trader_proposals | Claude | 2026-07-01 | **NOT YET APPLIED.** trade_proposals table (30-min expiry); decision_journal table; account_number default 605420650 |
| Phase 5: `/api/agents/trader` — TraderAgent proposals + approval | Claude | 2026-07-01 | HARDCODED AGENTIC_ACCOUNT=605420650; builds proposals from qualifying signals; approve/reject; expiry check; account mismatch safety block; kill-switch re-check at approval |
| AgentsPage — Experiments tab (🔬) | Claude | 2026-07-01 | Strategy versions list (champion badge, state, experiment metrics); Run Backtest button → /api/agents/backtest; results grid with gate pass/fail and failure reasons |
| AgentsPage — Proposals tab (⚡) | Claude | 2026-07-01 | Pending proposals list; Approve/Reject buttons; price drift warning (>3%); expiry countdown; risk check badges; "Generate Proposals" trigger |

## ✅ Session 2026-06-30

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Migration 032 — asset_class on agent_signals | Claude + Vaibhav | 2026-06-30 | `asset_class` column; seeds ETF/metal symbols; index |
| Migration 033 — learner controls | Claude + Vaibhav | 2026-06-30 | `learning_priors` (15 Bayesian priors), `learner_config` (per-dimension toggles), `signal_weights_history` (rollback snapshots); `mutations_paused`/`pause_reason` on `learner_runs` |
| LearnerAgent full rewrite — true DeepSeek tool-use agent | Claude | 2026-06-30 | 9 tools: read_priors, query_learner_config, query_signals_with_outcomes, query_score_correlation, query_macro_context, read_past_learnings, write_hypothesis, update_signal_weight, finish; auto-guard blocks mutation if last 3 runs win_rate < 35%; phase gate: requires 10+ closed trades |
| Learner Controls tab + Weight History tab in AgentsPage | Claude | 2026-06-30 | Per-dimension learn_from/allow_mutation toggles + min_confidence; weight history table with rollback + factory reset |
| `/api/agents/learner-controls` route (GET/PATCH/POST) | Claude | 2026-06-30 | GET: config + last 30 snapshots; PATCH: update dimension config; POST: rollback or factory_reset |
| Metals basket cap fix in research-agent | Claude | 2026-06-30 | Metals (GLD/SLV/GDX/IAU) were cut by 10-symbol cap; fixed to append unconditionally after cap |

---

## ✅ Session 2026-06-29

| Task | Agent | Completed | Notes |
|---|---|---|---|
| Dynamic exit price management | Claude | 2026-06-29 | migration 026; `price_target`, `stop_loss`, `highest_price`, `target_updated_at`, `exit_reason` on `paper_positions`; trailing stop = max(original_stop, highest_price × 0.93) |
| Risk profile system | Claude | 2026-06-29 | migration 027; `risk_profile`, `score_threshold`, `position_size_pct`, `stop_loss_pct`, `target_pct` on `strategy_config`; Conservative/Balanced/Aggressive presets; `/api/settings/risk-profile` GET/PATCH; Settings → Agents tab card |
| Visual Agent Mermaid diagrams | Claude | 2026-06-29 | `components/dashboard/AgentDiagram.tsx`; clickable flowcharts per agent; color-coded by node status; click → detail drawer; 7 JSON files in `public/agent-diagrams/` |
| TradingView CSV watchlist import | Claude | 2026-06-29 | Import CSV button + modal in WatchlistPanel; `EXCHANGE:TICKER,Description` format; batch POST with progress |
| Signal backtest tab | Claude | 2026-06-29 | AgentsPage backtest tab; joins agent_signals to paper_trades by symbol+date ±3 days; shows Hit Rate, Misses, Open, Avg Return |
| Position Monitor | Claude | 2026-06-29 | `/api/agents/position-monitor/route.ts`; TradingPage card + Run button; scheduled weekdays 4:15PM |
| Insider transactions in ResearchAgent | Claude | 2026-06-29 | `scoreInsider()` in `lib/research-agent.ts`; Alpha Vantage INSIDER_TRANSACTIONS; 90-day buy/sell ratio; injected as pre-fetched context in LLM prompt |
| Smart Money Trades in MarketsPage | Claude | 2026-06-29 | `/api/markets/insider-trades/route.ts`; Alpha Vantage insiders + House Stock Watcher congressional trades; Insiders/Congress tabs |
| LLM Cost Monitor | Claude | 2026-06-29 | `/api/admin/llm-costs/route.ts`; queries `llm_call_log`; burn rate, projected daily, per-model breakdown, 24-bar hourly chart; Settings → Agents tab; DashboardHome banner if projected daily > $2 |
| Mentor nav + judgment score chart | Claude | 2026-06-29 | Mentor link restored in DashboardShell sidebar (🎓 under Learn); `/api/mentor/scores/route.ts`; MentorPage Recharts LineChart; reference lines at 50/70/90 |
| MacroSentinel recession agent | Claude | 2026-06-29 | `/api/agents/macro-sentinel/route.ts`; 8 Alpha Vantage indicators; weighted danger score 0-100; GREEN/YELLOW/ORANGE/RED regimes; advisory-only; migrations 028; MarketsPage gauge + signal table; DashboardHome colored banner; Mondays 8AM |
| Mermaid build fix | Claude | 2026-06-29 | Downgraded mermaid v11→v10; fixes ESM/webpack incompatibility with es-toolkit; build passes |
| Windows Task Scheduler — 7 tasks | Claude | 2026-06-29 | ResearchAgent weekdays 9AM, PaperTrader 9:30AM, PositionMonitor 4:15PM, LearnerAgent Mondays 6AM, ThemeScout Sundays 8PM, DeepSeekAgent weekdays 9AM, MacroSentinel Mondays 8AM |

---

## 🟣 Review

| Task | Agent/Model | Status | Date | Notes |
|---|---|---|---|---|
| Governed agentic quant platform architecture | Codex (Architect) | review | 2026-06-27 | Canonical spec written; awaiting Vaibhav review before implementation planning |

---

## 🟡 Planned (Approved, Ready to Build)

| Task | Assigned To | Status | Date | Notes |
|---|---|---|---|---|
| Signal backtest validation | Builder | planned | — | Run `/api/agents/backtest` after signals accumulate; verify gate metrics |
| knowledge/event-patterns/ population | Builder | planned | — | Fed decision patterns, earnings behavior feeds LearnerAgent |
| Mobile push notifications for proposals | Builder | planned | — | Phase 5; low priority until proposals flow is exercised |

---

## 🔵 Blocked

| Task | Blocked By | Notes |
|---|---|---|
| LearnerAgent weight mutation (Phase 1 gate) | 10+ closed paper trades | Auto-guard + phase gate built; waiting on paper trading data |
| Experiments tab metrics | Migration 036 not applied | spy_nav/spy_return_pct/alpha_pct columns missing until 036 applied |
| Proposals tab | Migration 037 not applied | trade_proposals + decision_journal tables missing until 037 applied |
| TraderAgent actual Robinhood order | Proposals tab approved proposal | Route is built; Robinhood MCP call must be triggered from UI after user approves |

---

## ✅ Completed

| Task | Agent | Completed | Notes |
|---|---|---|---|
| PRD.md written | Claude | 2026-06-01 | Full spec in PRD.md |
| AGENTS.md written | Claude | 2026-06-01 | Multi-agent coordination layer |
| Knowledge base created | Claude | 2026-06-01 | 6 files, see knowledge/ |
| Robinhood MCP connected | Vaibhav + Claude | 2026-06-01 | 6 accounts found, agentic: ••••0660 |
| Robinhood accounts read | Claude | 2026-06-01 | get_accounts called successfully |
| Design system migration | Claude | 2026-06-27 | fo-* tokens, shadcn components, DashboardShell rewrite |
| Governed agentic quant platform architecture | Codex | 2026-06-27 | Canonical spec; see PROJECT_DECISIONS.md |
| LLM Router (Claude/DeepSeek/Groq routing by task) | Claude | 2026-06-29 | lib/llm-router.ts; routes by task type, cost tier |
| Groq Llama 3.3 70B free tier integration | Claude | 2026-06-29 | Added to router after DeepSeek; free-tier slot |
| DeepSeek R1 integration | Claude | 2026-06-29 | Cheaper chat/summarize tasks; API key in vault |
| Multi-paper-account comparison (agent_label system) | Claude | 2026-06-29 | Tracks which LLM produced each signal; P&L by model |
| LLM call log + admin history page | Claude | 2026-06-29 | Cost + token tracking per model; /dashboard/activity |
| API key vault (PIN protected) | Claude | 2026-06-29 | /dashboard/settings; encrypted key storage |
| Earnings calendar → Massive API (no LLM) | Claude | 2026-06-29 | Direct API, no LLM cost on calendar fetch |
| Markets overview → Massive API (live index quotes) | Claude | 2026-06-29 | Direct API, real-time quotes |
| Features page | Claude | 2026-06-29 | /dashboard/features; timeline of all shipped features |
| Social sentiment (StockTwits + Alpha Vantage) | Claude | 2026-06-29 | Sentiment signals for ResearchAgent screener |
| Strategy classification engine (7 strategies) | Claude | 2026-06-29 | Momentum, GARP, Value, Dividend, Growth, Macro, Contrarian |
| DeepSeek research agent variant | Claude | 2026-06-29 | Parallel agent; produces signals for LLM P&L comparison |
| Symbol detail page (candlestick, agent signals, chat) | Claude | 2026-06-29 | /dashboard/symbol/[ticker]; EMA/SMA/volume overlays |
| Symbol navigation from Portfolio, Markets, Activity | Claude | 2026-06-29 | Clickable tickers link to symbol detail page |
| Sector line chart (multi-sector performance) | Claude | 2026-06-29 | SectorLineChart component; multiple sectors on one chart |
| DB migration 010 (llm_call_log, agent_labels) | Claude + Vaibhav | 2026-06-29 | Applied to production Supabase |
| DB migration 011 | Claude + Vaibhav | 2026-06-29 | Applied to production Supabase |
| price_cache table (on-demand candle caching) | Claude | 2026-06-29 | Caches Massive API candle responses |
| Bell dropdown fix (position: fixed) | Claude | 2026-06-29 | Sticky header stacking context — fixed to viewport |
| Watchlist toggles (migration 020 + PATCH API) | Claude | 2026-06-29 | research_enabled, alert_on_signal, alert_on_earnings per symbol |
| WatchlistPanel rewrite (quotes, source badges, settings) | Claude | 2026-06-29 | Price quotes via /api/markets/quote; per-item expand |
| BriefingPage symbol auto-suggest | Claude | 2026-06-29 | Regex extraction of tickers from brief text; watchlist + Watch chips |
| pgvector enabled + agent_memory table (migration 021) | Claude + Vaibhav | 2026-06-29 | Applied to production; vector(1536) + ivfflat index |
| PageHeader on Strategies + Settings pages | Claude | 2026-06-29 | Consistent what/why/look-for on all dashboard pages |
| Vault Change PIN button + API handler | Claude | 2026-06-29 | change_pin action updates app_settings.vault_pin; persists across restarts |
| Vault Edit key button + preserve existing value | Claude | 2026-06-29 | Edit pre-fills form; blank key_value = keep existing; API skips update if blank |
| PageHeader on Activity, Learning, You, Trading, Agents, Mentor | Claude | 2026-06-29 | All 8 dashboard pages now have consistent what/why/look-for header |
| Options chain tab in SymbolDetailPage | Claude | 2026-06-29 | Chart/Signals/Options/Chat tabs; put-call ratio, avg IV, calls+puts table |
| Options chain API route | Claude | 2026-06-29 | /api/options/chain?symbol=X; Alpha Vantage REALTIME_OPTIONS; revalidate 300s |
| Batch quotes endpoint | Claude | 2026-06-29 | /api/markets/quotes?symbols=A,B,C; parallel fetch, max 20 symbols, 1 round-trip |
| WatchlistPanel → batch quotes | Claude | 2026-06-29 | 15–20 serial calls replaced with 1 batch call; limit raised 15→20 |
| Company name auto-fetch on watchlist add | Claude | 2026-06-29 | POST /api/watchlist calls Alpha Vantage COMPANY_OVERVIEW if name not provided |
| Alpha Vantage API key added | Vaibhav + Claude | 2026-06-29 | In .env.local + vault DB; powers options, sentiment, company name |
| Vault providers expanded | Claude | 2026-06-29 | Added massive, alphavantage, robinhood, supabase providers + market_data/sentiment/options tasks |
| TypeScript error fixes | Claude | 2026-06-29 | theme-scout raw.text fix; tailwind darkMode array→string; supabase/functions excluded from tsconfig |
| Grammarly hydration error suppressed | Claude | 2026-06-29 | suppressHydrationWarning on <body> in app/layout.tsx |

### Design System Migration (2026-06-27) — What was built
- `app/globals.css` — full fo-* token system (trading-purple accent #6366F1, dark-first)
- `tailwind.config.ts` — fo-* color tokens wired to CSS vars
- `postcss.config.mjs` — Tailwind v4 postcss plugin
- `lib/utils.ts` — cn() utility (clsx + tailwind-merge)
- `components/ui/card.tsx` — shadcn Card/CardHeader/CardContent/CardFooter/CardTitle/CardDescription
- `components/ui/button.tsx` — shadcn Button (no Radix Slot dep, simplified)
- `components/ui/badge.tsx` — shadcn Badge with CVA
- `components/ui/sparkline.tsx` — Recharts sparkline, fo-green/fo-red auto-color
- `components/ui/pct-pill.tsx` — % change pill with ArrowUp/ArrowDown, fo-* colors
- `components/dashboard/DashboardShell.tsx` — rewritten, added /agents and /trading nav items
- Added deps: clsx, tailwind-merge, class-variance-authority

---

## 📋 Backlog (Not Yet Approved)

| Task | Type | Priority | Notes |
|---|---|---|---|
| TraderAgent — approval_required mode (real Robinhood orders) | Feature | High | After signal validation; account ••••0660 only |
| LearnerAgent — weekly weight mutation | Feature | Medium | After 10+ closed trades (Phase 0 gate) |
| strategy_config UI editor | Feature | Low | Phase 1 last |
| Mobile trade approval push notifications | Feature | Low | Phase 5 |
| knowledge/event-patterns/ population | Research | High | Fed decisions, earnings patterns, macro |
| SEC EDGAR Form 4 insider trades | Integration | Medium | Free API |
| Railway cron deployment | Infrastructure | Medium | Phase 5 alternative to pg_cron |

---

## Architecture Decisions Log (Quick Ref)

Full details in `PROJECT_DECISIONS.md`. Summary here:

| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Styling | fo-* tokens + shadcn | Tailwind only | Design system consistency |
| DB | Supabase | Prisma/PlanetScale | Already active |
| Primary AI | Anthropic Claude | OpenAI | Already integrated, best reasoning |
| LLM routing | Claude → DeepSeek → Groq by task | Single model | Cost optimization + comparison |
| Trading | Robinhood MCP | Alpaca, IBKR | Robinhood native agentic support |
| Price data | Massive API (Polygon.io) | Yahoo Finance | Reliability + options data |
| Screener primary | FinancialDatasets screen_stocks | Robinhood run_scan | Deeper fundamentals |
| Vector store | pgvector (Supabase) | Pinecone | No new infra needed |
| Agent mode default | approval_required | auto | Safety first |
| Screener candidates/day | 3 max | 5 | 10% position sizing → max 10 positions |
| Regime detection | None (scoring adapts naturally) | Explicit bull/bear mode | Fragile; scoring handles it |
| Learning schedule | Weekly batch | Per-trade | Need 10+ trades; per-trade is noise |

---

## How to Add a Task (Any Agent)

1. Add to "Planned" or "Backlog" section
2. Tag with your model name in "Assigned To"
3. Move to "In Progress" when you start
4. Move to "Completed" when done, note what you built

---

*Last updated: 2026-06-29 by Claude (Sonnet 4.6)*
