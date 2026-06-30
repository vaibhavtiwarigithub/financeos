# Project Decisions — FinanceOS

## Purpose

Records approved product, architecture, UX, technical, and business decisions.

Only approved decisions belong here. Proposed decisions live in PROJECT_BUILD_LOG.md until approved.

## Decision Template

```
### Decision <N>: <Title>

Date:
Status: Approved
Category: Product / UX / Architecture / Technical / Business / Data / Security

Context:
Decision:
Reason:
Alternatives considered:
Impact:
Files/features affected:
Reversal cost: Low / Medium / High
```

---

### Decision 1: Governed Multi-Agent Quant Platform

Date: 2026-06-27
Status: Approved
Category: Product / Architecture / Security

Context: FinanceOS needs to research continuously, run experiments, explain decisions, and eventually execute through the Robinhood agentic account without allowing probabilistic AI reasoning to bypass financial controls.
Decision: Separate Data, Research, Analyst, Validation, Strategy Registry, Paper Execution, Learner, Risk/Tax, Explainer, and Live Trade Gateway responsibilities. LLMs may propose and explain; deterministic services calculate prices, P&L, validation, risk, tax flags, and execution state.
Reason: Reproducibility, fault isolation, auditability, and safety are required before paper evidence or live execution can be trusted.
Alternatives considered: Single adaptive super-agent; batch-only quant laboratory.
Impact: Replaces the current prompt-driven loop with governed contracts and lifecycle states.
Files/features affected: `features/agentic-quant-platform/FEATURE_ARCHITECTURE.md` and future phased implementation files.
Reversal cost: High

### Decision 2: Initial Trading Scope and Live Authority

Date: 2026-06-27
Status: Approved
Category: Product / Security / Business

Context: The initial system must align paper behavior with the Robinhood agentic cash account while preserving a safe path to future automation.
Decision: Use long-only 2-20 market-day swing strategies over Robinhood-supported US equities and ETFs that pass quality filters. Every initial live order requires Vaibhav's explicit approval. Future auto-live requires a separate strategy-specific, capital-limited, time-bounded manual unlock and cannot be enabled by an agent.
Reason: Aligns research with executable reality and prevents silent expansion of trading authority.
Alternatives considered: Long/short paper strategies; unrestricted Robinhood universe; immediate auto-live.
Impact: Shorts, options, leverage, crypto, intraday trading, and non-agentic accounts are excluded.
Files/features affected: Strategy Registry, paper execution, Risk Engine, Live Trade Gateway, and trading UI.
Reversal cost: Medium

### Decision 3: Evidence, Data, and Online Research Policy

Date: 2026-06-27
Status: Approved
Category: Data / Architecture

Context: Current prototype routes ask an LLM for prices and unsourced scores, which invalidates P&L and experimental evidence.
Decision: Use free-first replaceable data adapters, point-in-time append-only evidence, source provenance, and abstention when required data is missing or contradictory. Primary and curated sources establish evidence; broad web/social sources may generate hypotheses only. TradingView is a manual analysis/import tool, not an unattended API.
Reason: Market evidence must be deterministic, timestamped, reproducible, and auditable.
Alternatives considered: LLM-mediated data retrieval; a hardwired single provider; unrestricted web evidence.
Impact: LLM-generated authoritative prices are prohibited and current paper results require stabilization before being trusted.
Files/features affected: Data Hub, evidence store, provider adapters, current agent routes, and paper accounting.
Reversal cost: High

### Decision 4: Controlled Self-Improvement and Strategy Promotion

Date: 2026-06-27
Status: Approved
Category: Architecture / Data / Security

Context: Direct weight changes from individual trades chase noise and allow a LearnerAgent to alter production behavior without sufficient evidence.
Decision: LearnerAgent creates immutable challenger versions. A deterministic Python Validation Engine applies a dynamic statistical evidence gate. Risk may veto deployment. Vaibhav alone promotes an eligible challenger to champion.
Reason: Self-improvement must follow a falsifiable, reproducible experiment lifecycle and preserve failed evidence.
Alternatives considered: Fixed time/trade thresholds; direct weekly weight mutation; fully manual evidence review with no system gate.
Impact: Introduces Strategy Registry, experiment artifacts, eligibility reports, and champion/challenger governance.
Files/features affected: Agent learning, validation worker, strategy persistence, paper engine, and review UI.
Reversal cost: High

### Decision 6: MacroSentinel — Advisory-Only Regime

Date: 2026-06-29
Status: Approved
Category: Product / Architecture

Context: MacroSentinel computes a recession danger score and regime (GREEN/YELLOW/ORANGE/RED) from 8 macro indicators. The question was whether to auto-throttle agents or halt trading when regime worsens.
Decision: Advisory-only. MacroSentinel reports regime and shows it on the dashboard. It does NOT auto-throttle agents, reduce position sizes, or halt PaperTrader.
Reason: Auto-throttle without the user first observing a live run creates surprising behavior. Vaibhav reviews the regime card and decides whether to act — e.g., manually tightening the risk profile or pausing trading.
Alternatives considered: Auto-throttle on ORANGE/RED; auto-reduce position_size_pct when score > 50.
Impact: MarketsPage gauge + DashboardHome banner are display-only. No agent behavior changes automatically based on macro regime.
Files/features affected: `/api/agents/macro-sentinel`, `macro_regime`, `macro_signals`, MarketsPage, DashboardHome
Reversal cost: Low (adding auto-throttle later is additive)

---

### Decision 7: Mermaid v10 (not v11)

Date: 2026-06-29
Status: Approved
Category: Technical

Context: AgentDiagram.tsx uses Mermaid to render flowcharts. Mermaid v11 was installed initially.
Decision: Pin mermaid to v10.
Reason: Mermaid v11 depends on es-toolkit, which is ESM-only and incompatible with Next.js webpack bundler. Build failed with module resolution errors. v10 does not have this dependency and builds cleanly.
Alternatives considered: Dynamic import workaround for v11 (fragile, not worth it).
Impact: Agent diagrams render correctly. No feature difference between v10 and v11 for our use case.
Files/features affected: `package.json`, `components/dashboard/AgentDiagram.tsx`
Reversal cost: Low

---

### Decision 8: Insider Scoring as LLM Context Injection (Not Score Override)

Date: 2026-06-29
Status: Approved
Category: Architecture

Context: ResearchAgent needed to incorporate insider transaction signals (Form 4-equivalent via Alpha Vantage INSIDER_TRANSACTIONS).
Decision: `scoreInsider()` computes a 90-day buy/sell ratio from insider transactions and injects the result as pre-fetched context text in the LLM prompt. The LLM weighs it alongside other signals. It is NOT added as a hardcoded numeric score component.
Reason: LLM can weigh insider data contextually (e.g., a CEO buy during market panic is more meaningful than a routine RSU sale). Hardcoding it as a fixed weight component removes that nuance.
Alternatives considered: Add `insider_buying` as a fixed-weight signal in the signal_breakdown JSON.
Impact: Insider data informs every ResearchAgent run without locking a specific weight.
Files/features affected: `lib/research-agent.ts`
Reversal cost: Low

---

### Decision 9: Risk Profile Presets (Conservative / Balanced / Aggressive)

Date: 2026-06-29
Status: Approved
Category: Product / Data

Context: Strategy config needed user-selectable risk modes to control score thresholds, position sizing, stops, and targets.
Decision: Three named presets stored in `strategy_config`:
- Conservative: score_threshold=72, position_size_pct=7, stop_loss_pct=5, target_pct=12
- Balanced: score_threshold=60, position_size_pct=10, stop_loss_pct=7, target_pct=20
- Aggressive: score_threshold=52, position_size_pct=15, stop_loss_pct=10, target_pct=35
User can select a preset or edit fields individually.
Reason: Named presets make risk configuration intuitive. Per-field override preserves flexibility.
Alternatives considered: Single numeric "risk tolerance" slider; no presets (all manual).
Impact: ResearchAgent reads `score_threshold` from strategy_config; PaperTrader reads `position_size_pct` and `stop_loss_pct`.
Files/features affected: migration 027, `/api/settings/risk-profile`, Settings page, `lib/research-agent.ts`, PaperTrader
Reversal cost: Low

---

### Decision 10: House Stock Watcher for Congressional Trades (not Quiver Quant)

Date: 2026-06-29
Status: Approved
Category: Data / Technical

Context: Smart Money Trades feature needed congressional stock disclosure data.
Decision: Use House Stock Watcher public S3 endpoint (free, no auth, public domain data).
Reason: Free and publicly maintained. Quiver Quant charges for the same underlying public disclosure data. No auth token management needed.
Alternatives considered: Quiver Quant API (paid), SEC EDGAR EDGAR-Online (complex parsing).
Impact: Congressional trades tab in MarketsPage powered by House Stock Watcher JSON feed.
Files/features affected: `/api/markets/insider-trades/route.ts`
Reversal cost: Low (drop-in replacement if Quiver Quant becomes preferable)

---

### Decision 5: Explainability and Evolving Rule Governance

Date: 2026-06-27
Status: Approved
Category: Product / UX / Security

Context: Vaibhav wants to understand what the system thinks, plans, and learns while market, dividend, tax, regulatory, and broker rules evolve.
Decision: Provide a layered decision journal and daily briefing. Automatically update validated market observations and corporate events. Tax, regulatory, broker, risk, and behavior-changing rule updates are versioned, impact-assessed, and require governed review; risk and execution policy never change silently.
Reason: Continuous learning must remain understandable and must not silently broaden financial authority.
Alternatives considered: Chat-only explanations; static reports; unrestricted automatic rule updates.
Impact: Adds evidence labels, rule-version review, tax/dividend flags, and auditable user decisions.
Files/features affected: Explainer, knowledge store, daily briefing, decision journal, Risk/Tax Engine, and rule monitoring.
Reversal cost: Medium
