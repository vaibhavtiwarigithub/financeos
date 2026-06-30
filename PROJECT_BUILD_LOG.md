# Project Build Log — FinanceOS

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

### Format

```
### Entry <N> — <YYYY-MM-DD>

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

### Entry 2 — 2026-06-29 (Session batch)

Instruction: Build 13 features spanning exit management, risk profiles, macro intelligence, cost monitoring, agent visualization, data import, and backtesting.
Classification: Feature request (batch — all approved and implemented in session)
Affected area: paper_positions, strategy_config, new macro_regime/macro_signals tables, MarketsPage, AgentsPage, TradingPage, DashboardHome, MentorPage, Settings, WatchlistPanel, ResearchAgent, LearnerAgent, admin APIs
Impact: High
Architecture impact: Major (3 new migrations, 7 new API routes, 7 new scheduled tasks, 2 new DB tables)
Risk: Complexity — 7 concurrent scheduled tasks; advisory-only macro regime chosen deliberately to avoid surprising auto-throttle behavior
Decision status: Implemented
Notes: All 13 features shipped. Key governance choices: MacroSentinel is advisory-only; insider scoring is LLM-context injection not hardcoded weight override; mermaid pinned to v10 (v11 ESM-incompatible with webpack); House Stock Watcher chosen over Quiver Quant (free vs paid). Risk profile presets approved: Conservative 72/7/5/12, Balanced 60/10/7/20, Aggressive 52/15/10/35.

**Features completed:**
1. Dynamic exit price management — migration 026, trailing stop = max(original_stop, highest_price × 0.93), PositionMonitor runs 4:15PM weekdays
2. Risk profile system — migration 027, Conservative/Balanced/Aggressive presets, /api/settings/risk-profile, Settings Agents tab card
3. Visual Agent Mermaid diagrams — AgentDiagram.tsx, 7 JSON files in public/agent-diagrams/, mermaid v10, click → detail drawer
4. TradingView CSV watchlist import — Import CSV modal in WatchlistPanel, EXCHANGE:TICKER format, batch POST with progress
5. Signal backtest tab — AgentsPage backtest tab, agent_signals joined to paper_trades ±3 days, Hit Rate/Misses/Open/Avg Return
6. Position Monitor — /api/agents/position-monitor, TradingPage card, scheduled weekdays 4:15PM
7. Insider transactions in ResearchAgent — scoreInsider() in lib/research-agent.ts, Alpha Vantage INSIDER_TRANSACTIONS, 90-day ratio injected as LLM context
8. Smart Money Trades in MarketsPage — /api/markets/insider-trades, Insiders + Congress tabs, House Stock Watcher S3
9. LLM Cost Monitor — /api/admin/llm-costs, burn rate + projected daily + per-model + 24-bar chart, Settings card + DashboardHome banner
10. Mentor nav + judgment score chart — sidebar link restored, /api/mentor/scores, MentorPage Recharts LineChart with 50/70/90 reference lines
11. MacroSentinel — /api/agents/macro-sentinel, 8 macro indicators, 0-100 danger score, 4 regimes, migration 028, MarketsPage gauge, DashboardHome banner, Mondays 8AM
12. Mermaid build fix — downgraded v11→v10, ESM/es-toolkit incompatibility resolved, build passes
13. Windows Task Scheduler — 7 Claude Code scheduled tasks covering all agents

---

### Entry 1 — 2026-06-27

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
