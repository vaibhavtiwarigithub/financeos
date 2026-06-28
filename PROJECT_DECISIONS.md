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
