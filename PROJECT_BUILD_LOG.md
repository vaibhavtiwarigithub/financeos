# Project Build Log â€” Kairos

## Purpose

Tracks how this project is being built over time. Records user instructions, feature requests, rule changes, architectural decisions, design decisions, scope creep, contradictions, and build discipline.

Goal: prevent random building. Compare workflow against best-practice product development.

## Current Build Discipline Summary

**Status:** Architecture-first. The governed agentic quant platform target is approved; implementation remains gated behind a reviewed phased plan.

Claude should update this summary periodically with:
- Is the project being built architecturally?
- Are instructions consistent?
- Are there contradictions?
- Are features approved before coding?
- Is the project drifting?
- Is the project becoming more focused or more bloated?

## Interaction Log

*Log meaningful instructions below. Skip tiny wording changes and obvious bug fixes.*

### Entry 5 - 2026-07-13

Instruction: Review the benchmark-alpha scorecard architecture for multi-horizon paper/live alpha vs configurable benchmarks, fix design flaws, and keep implementation code out of this design pass.
Classification: Architecture rule / Feature request
Affected area: Performance Truth Layer, benchmark data model, paper/live NAV analytics, LearnerAgent objective and promotion gate proposal.
Impact: High
Architecture impact: Major
Risk: Complexity / overfitting / misleading financial metrics if built without provenance and confidence gates.
Decision status: Proposed
Notes: Codex corrected `features/benchmark-alpha/FEATURE_ARCHITECTURE.md` before implementation. Key design changes: scorecard belongs inside Performance Truth, not a parallel system; live aggregation requires explicit market/currency/book-scope provenance before summing accounts; info ratio is annualized daily mean excess divided by daily tracking error, not cumulative excess divided by daily stdev; unpriceable benchmarks must write visible unavailable rows instead of disappearing; Phase 2 learner/promotion usage is gated to longer confidence-qualified windows and remains additive to existing validation, not a replacement.

### Entry 6 - 2026-07-13

Instruction: Review the capital-rotation architecture for opportunity-cost sell-to-fund behavior when fully invested, fix design flaws, and keep implementation code out of this design pass.
Classification: Architecture rule / Feature request
Affected area: PaperTrader insufficient-cash path, Trader proposal flow, PositionMonitor exit boundary, investment mandates, paper/live money-path safety, audit ledger.
Impact: High
Architecture impact: Major
Risk: Complexity / churn / unintended live or paper sell behavior if built without atomic execution, exit precedence, and two-leg reconciliation.
Decision status: Proposed
Notes: Codex corrected `features/capital-rotation/FEATURE_ARCHITECTURE.md` before implementation. Key design changes: rotation is a deterministic evaluator invoked by existing entry flows, not a standalone autonomous seller; P0 is shadow-only; P1 paper execution requires an atomic sell+buy RPC; P2 live creates approval-required two-leg proposals with broker reconciliation; PositionMonitor exits always win; post-swap portfolio gates, turnover, cost/tax, persistence, benchmark-alpha availability, and append-only audit lifecycle are mandatory.

### Entry 7 - 2026-07-13

Instruction: "go build all pending" after benchmark-alpha and capital-rotation architecture approval.
Classification: Approved implementation
Affected area: Performance Truth Layer, benchmark scorecard route/UI/schema, PaperTrader insufficient-cash path, capital-rotation shadow audit, docs/system map.
Impact: High
Architecture impact: Major
Risk: Money-path confusion if rotation execution is mistaken for shadow measurement; mitigated by keeping paper/live execution flags false and wiring only P0 shadow.
Decision status: Implemented
Notes: Built benchmark-alpha Phase 1 measurement (`benchmarks`, `benchmark_price_observations`, `benchmark_scorecard`, live provenance columns, `/api/agents/benchmark-scorecard`, `AlphaScorecard`, cron schedule) and capital-rotation P0 shadow (`rotation_config`, append-only `rotation_events`, deterministic evaluator, PaperTrader insufficient_cash shadow logging). No learner objective/promotion wiring, no paper rotation execution, and no live rotation proposals/orders were enabled.

### Entry 8 - 2026-07-15

Instruction: Independently review and correct the relationship-graph/event-propagation architecture after its literature-grounding pass.
Classification: Architecture rule / Feature request
Affected area: Canonical Evidence Router, issuer identity, disclosed customer relationships, EdgeScout/EdgeIC, research candidate attribution, learning governance, US/India isolation, and downside-hedge boundary.
Impact: High
Architecture impact: Major
Risk: False economic links, look-ahead bias, parallel provenance, overfit preprint-driven complexity, and unintended money-path influence.
Decision status: Proposed
Notes: Codex replaced V3 with a narrower V4. The first permissible experiment is US-only, sales-weighted disclosed customer momentum inside the existing measure-only `edge_*` lab. Stable relationships are neutral and separate from events; issuer entities are separate from ticker instruments; assertions are bitemporal, append-only, and evidence-linked; peers cannot seed economic edges; recent embedding papers remain offline hypotheses; India remains unsupported until an official source is validated; and no relationship result may change candidates, scores, suppression, sizing, exits, hedges, or orders without a later approved and validated phase. Recommended next action is P0 source/identity feasibility only.

### Entry 9 - 2026-07-15

Instruction: Independently review and correct the known-anomalies, India Markets parity, external-research shadow, and Canonical Evidence Router cutover architecture documents.
Classification: Architecture rule / Feature request
Affected area: Point-in-time anomaly research, India Markets data delivery, untrusted GitHub Actions compute, Router scoring cutover, eligibility and rollback governance.
Impact: High
Architecture impact: Major
Risk: Look-ahead bias, misleading breadth/coverage, provider bypass, supply-chain compromise, and missing-data changes creating new trade eligibility.
Decision status: Proposed
Notes: Codex corrected all four designs without implementation. PEAD is now a US-first data-feasibility study because Kairos does not store the required actual/consensus vintages; each definition is a separately counted trial. India Markets is a server-side hardening project because sectors and a ten-name sample already exist but call Yahoo from the client; the sample cannot be labeled full breadth. External research now uses trusted acquisition plus immutable snapshots and explicit `docker run --network none`; self-sourcing untrusted repos, secrets, direct candidate influence, and parallel provenance are prohibited. Router cutover now requires frozen same-input cohort evaluation before activation plus a separate runtime degradation guard, immutable policy activation, one market/intent family at a time, and a proven warm legacy rollback path.

### Format

```
### Entry <N> â€” <YYYY-MM-DD>

Instruction: What the user asked
Classification: [Product direction / Feature request / UI rule / Architecture rule / Technical rule / Bug fix / Random idea / Scope creep / Contradiction / Approved decision]
Affected area: Feature, screen, module, API, design system, data model, etc.
Impact: Low / Medium / High
Architecture impact: None / Minor / Major
Risk: Drift / Scope creep / Contradiction / Complexity / None
Decision status: Proposed / Approved / Rejected / Deferred / Implemented
Notes: Claude's assessment
```

---

### Entry 2 â€” 2026-06-29 (Session batch)

Instruction: Build 13 features spanning exit management, risk profiles, macro intelligence, cost monitoring, agent visualization, data import, and backtesting.
Classification: Feature request (batch â€” all approved and implemented in session)
Affected area: paper_positions, strategy_config, new macro_regime/macro_signals tables, MarketsPage, AgentsPage, TradingPage, DashboardHome, MentorPage, Settings, WatchlistPanel, ResearchAgent, LearnerAgent, admin APIs
Impact: High
Architecture impact: Major (3 new migrations, 7 new API routes, 7 new scheduled tasks, 2 new DB tables)
Risk: Complexity â€” 7 concurrent scheduled tasks; advisory-only macro regime chosen deliberately to avoid surprising auto-throttle behavior
Decision status: Implemented
Notes: All 13 features shipped. Key governance choices: MacroSentinel is advisory-only; insider scoring is LLM-context injection not hardcoded weight override; mermaid pinned to v10 (v11 ESM-incompatible with webpack); House Stock Watcher chosen over Quiver Quant (free vs paid). Risk profile presets approved: Conservative 72/7/5/12, Balanced 60/10/7/20, Aggressive 52/15/10/35.

**Features completed:**
1. Dynamic exit price management â€” migration 026, trailing stop = max(original_stop, highest_price Ã— 0.93), PositionMonitor runs 4:15PM weekdays
2. Risk profile system â€” migration 027, Conservative/Balanced/Aggressive presets, /api/settings/risk-profile, Settings Agents tab card
3. Visual Agent Mermaid diagrams â€” AgentDiagram.tsx, 7 JSON files in public/agent-diagrams/, mermaid v10, click â†’ detail drawer
4. TradingView CSV watchlist import â€” Import CSV modal in WatchlistPanel, EXCHANGE:TICKER format, batch POST with progress
5. Signal backtest tab â€” AgentsPage backtest tab, agent_signals joined to paper_trades Â±3 days, Hit Rate/Misses/Open/Avg Return
6. Position Monitor â€” /api/agents/position-monitor, TradingPage card, scheduled weekdays 4:15PM
7. Insider transactions in ResearchAgent â€” scoreInsider() in lib/research-agent.ts, Alpha Vantage INSIDER_TRANSACTIONS, 90-day ratio injected as LLM context
8. Smart Money Trades in MarketsPage â€” /api/markets/insider-trades, Insiders + Congress tabs, House Stock Watcher S3
9. LLM Cost Monitor â€” /api/admin/llm-costs, burn rate + projected daily + per-model + 24-bar chart, Settings card + DashboardHome banner
10. Mentor nav + judgment score chart â€” sidebar link restored, /api/mentor/scores, MentorPage Recharts LineChart with 50/70/90 reference lines
11. MacroSentinel â€” /api/agents/macro-sentinel, 8 macro indicators, 0-100 danger score, 4 regimes, migration 028, MarketsPage gauge, DashboardHome banner, Mondays 8AM
12. Mermaid build fix â€” downgraded v11â†’v10, ESM/es-toolkit incompatibility resolved, build passes
13. Windows Task Scheduler â€” 7 Claude Code scheduled tasks covering all agents

---

### Entry 3 — 2026-07-06 (Session batch: cloud-cron + learning-core Phase 2-3 + 4 architecture decisions)

Instruction: Migrate scheduling off the laptop onto Vercel + Supabase pg_cron so agents survive the machine being off; build the previously-approved Posture/Goals and Ops Calendar/Brokers/Models specs; build a Research Journal for pipeline transparency; then run an unbiased multi-agent code review of the whole session's diff and fix everything it found.
Classification: Architecture rule / Feature request (batch, all approved) / Bug fix (large batch surfaced by review)
Affected area: Deployment (Vercel silent trigger target), Supabase pg_cron (21 jobs), lib/research-agent.ts (scoring formula), lib/kill-switches.ts, lib/brokers/* (new adapter registry), app/api/goals/*, app/api/agents/research-journal/*, app/dashboard/research-journal, strategy_config (9 new columns), 3 new tables (trading_goals, pipeline_stage_events, feature_registry_history), profiles.market_focus (discovered missing entirely), lib/schedule.ts, DashboardShell nav.
Impact: High
Architecture impact: Major — Decisions 38 (Posture/Goals), 39 (Ops Calendar/Broker Registry/Model Freshness), 40 (Research Journal + signal_id join-key fix), 41 (scoring-weight renormalization) all logged in PROJECT_DECISIONS.md as Approved.
Risk: Complexity (broker adapter registry, weight renormalization) offset by resilient fallbacks throughout; a multi-agent ultra-review of the full diff afterward surfaced 15+ real defects (a dormant same-day kill-switch bug that pre-dated this session, a screener bucket-ordering bias that pre-dated this session, a regression introduced mid-session in an Alpaca status-type fix, several fixed-currency/absolute-threshold bugs, ~10 schema changes applied live via MCP with no committed migration file until this entry) — all fixed in the same session; this build log itself hadn't been updated since Entry 2 despite 4 major decisions shipping, which the review also caught.
Decision status: Implemented
Notes: Key lesson reinforced twice this session: a local `npm run build` can falsely report success on a stale `tsconfig.tsbuildinfo` incremental cache — always `rm -rf .next` before trusting a "build passed" result before deploying. Also: schema changes applied directly via the Supabase MCP tool must ALSO be written as committed `supabase/migrations/*.sql` files in the same change — this was skipped for ~10 changes tonight (migrations 072-080 backfill them after the fact) and should not recur.

---

### Entry 4 - 2026-07-06 (Codex adversarial review fix pass + agent-evolution architecture proposal)

Instruction: User ran an independent Codex review of the core scoring/trading/learning loop out of concern that missing/rate-limited data could silently corrupt signals; asked for every finding to be verified and fixed in priority order. Same thread, Codex sent a second addendum asking whether agent parameters/discovery sources/evolution surface are actually appropriate (not just bug-free) for a world-class US+India swing agent, requesting a written architecture note rather than immediate implementation.
Classification: Bug fix batch (Decision 43, implemented) + Architecture rule (agent-evolution proposal, DRAFT only per Architecture-First Mode)
Affected area: lib/social-sentiment.ts, lib/research-agent.ts, lib/data/scores.ts, new lib/scoring/weighted-score.ts, lib/validation/engine.ts, lib/learning/dataset.ts, app/api/agents/theme-scout/route.ts, lib/risk/sizing.ts, app/api/agents/paper-trade/route.ts, app/api/agents/learner/route.ts; new features/agent-evolution/FEATURE_ARCHITECTURE.md
Impact: High (bug fixes touch every scored decision); architecture proposal not yet implemented
Architecture impact: Major for the bug-fix batch (shared scoring contract now spans production + validation); the agent-evolution doc is DRAFT ONLY - no code shipped for discovery-source attribution, genome expansion, or India-specific thresholds
Risk: None beyond what Decision 43 already carries - the architecture doc explicitly defers all new tunable surface behind the existing challenger/validate/promote gate and repeats the locked pushback items (3 candidates/day, no explicit regime switching, no loosening trade approval) as constraints on itself
Decision status: Decision 43 (bug fixes) Implemented; agent-evolution architecture Proposed, awaiting approval
Notes: Also disabled all 15 Windows Task Scheduler \Kairos\ jobs at the user's request - they were still Ready and pointed at localhost:3000, duplicating pg_cron's cloud-triggered calls (LLM/API spend) whenever a local dev server happened to be running at trigger time. Actual duplicate trades were already prevented by paper-trade's signal-claiming idempotency (shared DB), but duplicate outbound API calls were real. pg_cron is now the sole scheduler.

---

### Entry 1 â€” 2026-06-27

Instruction: Design a self-improving agentic quant platform that continuously researches markets, runs shadow experiments, teaches the user, and can eventually trade through the Robinhood agentic account.
Classification: Approved decision
Affected area: Agent architecture, market data, evidence, validation, paper execution, Robinhood execution, risk, dividends, tax, explainability, and operations
Impact: High
Architecture impact: Major
Risk: Complexity
Decision status: Approved
Notes: Approved as a governed multi-agent platform. Long-only 2-20 market-day swing trading; Robinhood-supported US equities and ETFs subject to quality filters; dynamic statistical eligibility plus manual promotion; approval required for every initial live order; free-first data; layered daily briefing and decision journal. Canonical specification: `features/agentic-quant-platform/FEATURE_ARCHITECTURE.md`. Production implementation is not yet authorized.

## Drift Warnings

- Current prototype routes use LLM-generated prices and direct weight mutation, which conflict with the approved architecture.
- `PRD.md`, `WORK_LOG.md`, local migrations, and live connection state have diverged and must be reconciled during stabilization.
- Auto-live execution, options, shorts, leverage, crypto, and intraday trading are outside approved scope.

## Repeated Patterns

*Track repeated behavior such as:*
- *User often adds features before finishing architecture*
- *User changes UI rules after implementation*
- *User requests quick fixes that actually affect architecture*

## Best-Practice Build Flow Comparison

| Step | Status |
|---|---|
| 1. Problem definition | Not started |
| 2. Target user | Not started |
| 3. Core use cases | Not started |
| 4. Information architecture | Approved for governed agentic quant platform |
| 5. Feature architecture | Approved; written specification awaiting user file review |
| 6. Data architecture | Approved at contract level |
| 7. UI states | Defined at architecture level |
| 8. Implementation plan | Not started |
| 9. Build | Not started |
| 10. QA | Not started |
| 11. Launch | Not started |
| 12. Feedback loop | Not started |
