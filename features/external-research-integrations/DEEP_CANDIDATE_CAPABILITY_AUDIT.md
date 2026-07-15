# Deep Candidate Capability Audit

**Status:** Design-only intake record. No external code, package, service,
credential, provider, migration, deployment, or money-path change is approved
by this document.

**Decision in one sentence:** Kairos should build a small set of native,
evidence-bound research and learning capabilities inspired by the strongest
repositories; it should not embed their runtimes, data clients, brokers, agent
tools, or trading engines.

## 1. Review Depth and Rule of Use

This is a capability and adoption review, not a claim that every upstream
repository received a line-by-line security audit.

| Review depth | Meaning | Repositories |
| --- | --- | --- |
| Deep capability review | Current upstream pin, license, README, tree, representative implementation/configuration and dependency surfaces reviewed. Not a full security audit. | Vibe-Trading, Qlib, TA-Lib Python, FinRL, FinGPT, OpenBB, QuantDinger, Ghostfolio, Daily Stock Analysis, ML4T, Qbot |
| Targeted review | License, current documentation/tree, architecture surface and declared integrations reviewed. | Tushare, FinceptTerminal, vn.py, AI Berkshire (upstream identity still needs verification), Blockchain Guide |
| Intake only | Metadata/topic-page review only. Not an adoption candidate without a new review. | Remaining catalog entries |

Every `reference_only` decision means clean-room: learn a product or research
idea, write Kairos requirements and tests independently, and do not copy code,
module layout, prompt text, notebooks, or implementation structure. This rule
applies even to permissively licensed repositories unless a later written
decision approves a narrow import after license and security review.

## 2. Non-Negotiable Kairos Boundary

The Canonical Evidence Router and its `EvidenceEnvelope` remain the only
provenance boundary for market or fundamental evidence. Experiment lineage is
not a new provenance store: it extends the existing `experiment_runs` record
and references immutable `evidence_records`, the Router policy version, and
input evidence-cache/ledger fingerprints or snapshot ids. It must never copy,
re-derive, or replace those records. No imported component may fetch a provider
directly and then feed scoring, a promotion decision, portfolio allocation,
paper execution, or live execution.

Research may propose hypotheses. Deterministic Kairos services must validate
and approve them. The following remain prohibited:

1. An LLM choosing a trade, position size, stop, sell, or live order.
2. Cross-market or cross-currency portfolios, benchmarks, backtests, or alpha.
3. An external broker adapter, MCP tool, shell tool, file tool, or generated
   program on any money path.
4. Silent provider fallback, undocumented data transformations, or unversioned
   formulas.
5. Live activation without existing approval, kill-switch, per-market,
   drawdown, mandate, and reconciliation gates.

## 3. What Kairos Should Actually Build

These are native Kairos features, ordered by value, safety, and dependency.
They are designs to approve separately, not implementation authorization.

| Priority | Native capability | Best source of ideas | Value | Hard boundary | Earliest prerequisite |
| --- | --- | --- | --- | --- | --- |
| 1 | Experiment lineage extension and recorder | Qlib | Reproducible score/strategy evaluation: linked evidence snapshot/fingerprint ids, formula versions, parameters, market/book, artifacts, status and failure. | Extend existing `experiment_runs`; reference existing Router and decision evidence, never duplicate it. No MLflow, Qlib runtime, external artifact store or subprocess. | Router Phase 4 parity and entry-eligibility guard complete. |
| 2 | Strategy lifecycle and decay review | Vibe-Trading, ML4T | Explicit idea, shadow, validated, active paper, degraded and retired states prevent silent strategy staleness. | Deterministic thresholds and owner-visible evidence; no LLM promotion or self-editing strategy. | Experiment lineage and enough closed market-local observations. |
| 3 | Evaluation diagnostics and attribution | Vibe-Trading, ML4T, Qlib | Separates beta, sector exposure, timing, concentration and a repeatable signal. | Per market/currency only; existing Performance Truth Layer remains NAV/return authority. | Stable performance and benchmark-alpha measurement. |
| 4 | Counterfactual trade journal | Vibe-Trading, Ghostfolio product ideas | Explains held vs exited, missed opportunity, stop/target behavior and decision quality. | Advisory history only; never changes ledgers, positions, prices, or trades. | Reliable paper/live event and NAV history. |
| 5 | TradingView Pine export | Vibe-Trading | Lets the owner inspect a deterministic read-only hypothesis in TradingView Pro. | One-way export; Pine output is never authoritative evidence or an execution instruction. | Formula registry and fixture-tested indicator semantics. |
| 6 | Formula parity harness | TA-Lib | Tests a small Kairos-owned indicator set against known semantics and edge cases. | No TA-Lib production dependency, native binary, or price-provider path. | A documented technical-indicator gap. |
| 7 | Live-control adversarial checklist | QuantDinger | Sharpens review of authority scope, mode separation, idempotency, server-side live unlock and audit evidence. | Review Kairos gates only; import no gateway, broker code, tokens, or runtime. | Before live scope expands. |
| 8 | Portfolio/import UX ideas | Ghostfolio | Future reconciliation, activity audit, history and privacy-first explanations. | Clean-room product design only; Ghostfolio is AGPLv3. | Separate UX approval. |

The first three are the compounding advantage. They improve learning quality
without increasing data-provider, broker, or LLM authority.

## 4. Repository-by-Repository Decision

### 4.1 Qlib: Build the Recorder Pattern, Not Qlib

**Observed capability:** Qlib is an MIT Python quantitative research platform
with data management, workflows, a recorder, experiment artifacts, models,
backtesting and analysis. Its workflow/recorder model tracks scheduled,
running, completed and failed experiments with parameters and artifacts.

**Use:** Extend the existing Kairos `experiment_runs` lifecycle and its
immutable result artifacts. Each run links market, book/currency, Router policy
version, `evidence_records`, evidence-cache/ledger fingerprints or snapshots,
universe version, formula/strategy version, code version, run window,
parameters, deterministic metrics, confidence and status. The linked records
remain authoritative; the run must not replicate their payloads.

**Do not use:** Qlib runtime, MLflow dependency, data pipeline, model stack,
subprocess/artifact behavior, backtester, or investment models.

**Why:** This makes learner conclusions falsifiable and gives benchmark-alpha
and capital rotation a stable evidence base. Build it before a Vibe committee.

### 4.2 Vibe-Trading: Use Its Research Product Shape Selectively

**Observed capability:** MIT project with a large research toolbox: hypothesis
registry, research autopilot, factor/alpha libraries, PIT-oriented fundamental
research, multiple backtest/optimization/attribution modes, trade-journal and
shadow-account analysis, reports and TradingView/other export formats. See
`VIBE_TRADING_CAPABILITY_DEEP_DIVE.md` for the detailed map.

**Use:**

1. Hypothesis registry with explicit invalidation and decay states.
2. Experiment diagnostics, factor attribution and counterfactual journal.
3. Read-only Pine export of Kairos-owned, fixture-tested formulas.
4. Later, an isolated advisory research committee that writes proposals only.

**Do not use:** Vibe data loaders, 19-source provider integrations, brokers,
MCP tools, shell/file tools, persistent agent memory, generated code,
cross-market engine, backtest runtime, composite optimizer, server, or UI
runtime. Its breadth is exactly why it must not be trusted by default in a
real-account application.

**Conclusion:** Vibe has more research breadth than Kairos today. It is not a
substitute for Kairos's market-local performance truth, governed evidence
routing, owner approvals and execution controls. Adopt user outcomes, not its
runtime.

### 4.3 TA-Lib: A Semantic Test Oracle, Not a Feature Dependency

**Observed capability:** BSD-2-Clause Python/Cython wrapper around the TA-Lib C
library with 150+ indicators, pattern recognition and NumPy/Pandas/Polars APIs.
Its documentation highlights non-obvious warm-up, NaN propagation and
function-semantic differences, including RSI and STOCHRSI behavior.

**Use:** Compare a short list of approved Kairos formulas in an offline test
harness only when there is a demonstrated calculation gap. Store fixtures,
price adjustment basis, expected warm-up behavior, missing-data behavior and a
versioned formula id.

**Do not use:** A broad 150-indicator catalogue, a native production runtime,
an automatic feature factory, candlestick-pattern trading, or a serverless
bridge. More indicators create feature mining and semantic drift, not an edge.

**Decision:** Do not build this now. Implement native TypeScript only for an
indicator required by a specific score or research test.

### 4.4 ML4T: Use the Research Discipline

**Observed capability:** MIT educational project spanning market data,
microstructure, strategy definition, features, ML pipelines, simulation,
portfolio construction, costs, risk, reinforcement-learning execution and RAG
research case studies.

**Use:** A clean-room review checklist: define an economic hypothesis first,
make a point-in-time data contract, split train/validation/test by time, model
costs and turnover, establish a baseline, then record failure modes and regime
sensitivity.

**Do not use:** Notebooks, chapters as production code, local data recipes,
model pipelines, RL execution, or dependencies.

**Decision:** Methodology reference. It informs acceptance criteria for native
experiment lineage.

### 4.5 FinGPT: Do Not Add a Financial LLM Layer

**Observed capability:** MIT financial-LLM research project covering sentiment,
RAG, report analysis, forecasting, datasets and multi-agent/RoboAdvisor demos.

**Use:** At most, later evaluation-task design: grounded citation requirements,
representation of conflicting filings/news, and factual-summary scoring.

**Do not use:** Models, datasets, fine-tuning, RAG runtime, sentiment scores,
forecasting outputs, or autonomous multi-agent features. They add GPU, privacy,
data-rights and hallucination risks and must never determine a score or trade
direction.

**Decision:** Rejected as a runtime dependency.

### 4.6 FinRL: Reject as an Investment or Execution Engine

**Observed capability:** MIT DRL framework with train-test-trade flows,
A2C/DDPG/PPO/SAC/TD3 agents, multiple data sources, backtesting and live-broker
examples. Its dependency and operational surface is broad.

**Use:** Negative lessons only: walk-forward separation, transaction-cost
modeling and the fact that a backtest does not justify live automation.

**Do not use:** RL agents, environments, data connectors, backtester, live
examples, Alpaca/CCXT integrations or model artifacts.

**Decision:** Rejected. Current data depth, sample size and safety posture do
not support reinforcement learning.

### 4.7 OpenBB: Architecture Reference Only

**Observed capability:** Multi-provider financial platform with provider
adapters, platform API, CLI and desktop ecosystem.

**License:** Upstream LICENSE is AGPLv3.

**Use:** Conceptually, its provider-adapter ownership model. Kairos has already
chosen the stronger local expression: Evidence Router, `EvidenceEnvelope`,
durable cache, policy versions, pacing and ledger.

**Do not use:** OpenBB code, packages, platform, CLI, API runtime or provider
modules without a future explicit legal/commercial decision.

**Decision:** Reference-only; no technical integration.

### 4.8 QuantDinger: Borrow Control Objectives, Not Software

**Observed capability:** Apache-2.0 self-hosted AI trading platform with
strategy/backtest/paper/live modes, agent scopes, server-side live unlock,
broker adapters, idempotency/audit concepts and provider cache/rate controls.

**Use:** A clean-room live-control audit checklist. Verify Kairos has
mode-scoped authority, server-side live unlock, request idempotency,
append-only intent/order/reconciliation records, account binding and emergency
disabling.

**Do not use:** Its agent gateway, broker adapters, token model, provider code,
backtester or self-hosted runtime. Kairos retains its own choke points and
broker identity controls.

**Decision:** Targeted adversarial review only when live scope expands.

### 4.9 Ghostfolio: Good Owner Experience, Wrong License for Reuse

**Observed capability:** AGPLv3 TypeScript personal-portfolio application with
activity import/export, performance horizons, holdings/history, analytics and
privacy-oriented workflows.

**Use:** Clean-room requirements for future import, reconciliation and
portfolio-activity UX. Its performance-over-selected-horizon presentation is
relevant to benchmark-alpha UX.

**Do not use:** Source, packages, components or runtime. AGPLv3 requires a
distinct legal decision.

**Decision:** Reference-only UX input, later.

### 4.10 Daily Stock Analysis, Qbot and Other Full Stacks

**Observed capability:** Daily Stock Analysis provides scheduled multi-market
LLM reports and strategies; Qbot is a local research/trading project with many
strategy/data concepts. Other catalogued full stacks have similar broad
provider, runtime and execution surfaces.

**Use:** Coarse product ideas only, such as run-status visibility, scheduled
report visibility and operator diagnostics.

**Do not use:** LLM signal generation, provider clients, strategy engines,
execution paths, code, deployment model or local credentials.

**Decision:** No current adoption.

## 5. Data and Market Reality

External repositories do not solve Kairos data provenance. US and India
evidence must enter through approved Router intents and carry source,
timestamp, freshness, transformation, provider health and market/currency
metadata.

| Capability | US book | India book | Correct Kairos approach |
| --- | --- | --- | --- |
| Fundamentals | Router adapters only | Router adapters only | Source-specific envelopes; do not assume provider field equivalence. |
| Technical indicators | Market-local adjusted prices | Market-local adjusted prices | Version adjustment basis, calendar, missing-bar and warm-up policy. |
| Backtest/validation | USD book only | INR book only | Separate runs, benchmarks, costs/taxes/calendars; never aggregate raw returns. |
| Alpha/attribution | Primary US benchmark only | Primary India benchmark only | Performance Truth Layer owns NAV; scorecard references it. |
| Portfolio optimization | US positions only | India positions only | No cross-currency optimizer or shared cash pool. |

An apparent free source is not automatically eligible. Router policy must still
hold permitted use, actual quota behavior, freshness, quality, fallback
semantics and health history. Evidence gaps are visible gaps, never LLM-filled
or synthetic values.

## 6. Recommended Build Order

1. Finish the serial Router rollout: accumulate shadow evidence, implement the
   eligibility-flip guard, prove parity, then make a controlled market-by-market
   cutover. Do not start an external-repository feature while that gate is open.
2. Design and approve a Kairos-native Experiment Lineage feature inspired by
   Qlib and governed by the learning loop and Performance Truth Layer.
3. Add deterministic validation diagnostics: baseline comparison, common-window
   returns, costs, turnover, market-local sample floors, confidence and regime
   slices. Extend, do not duplicate, benchmark-alpha and strategy evaluations.
4. Add the strategy lifecycle/degradation state machine, paper-only initially,
   with owner-visible promotion, degradation and retirement reasons.
5. Add counterfactual journal and Pine export as read-only owner tools.
6. Only after records show a real research bottleneck, propose a small
   Vibe-inspired advisory committee in a separately sandboxed proposal-only
   architecture. It consumes evidence envelopes and emits typed hypotheses,
   never executable tools or orders.
7. Revisit TA-Lib for a proven semantic test gap, Ghostfolio for an approved UX
   feature and QuantDinger only as a control audit before broader live use.

## 7. Explicit No-Go List

1. Clone/fork-as-runtime of Vibe, Qlib, FinRL, FinGPT, OpenBB, QuantDinger,
   Ghostfolio, Daily Stock Analysis or Qbot.
2. Any external broker, MCP, agent tool, shell/file tool or generated-code tool
   in a research-to-order chain.
3. Generic alpha-library mining, automatic strategy generation, broad technical
   indicator expansion or RL optimization.
4. A shared US/India backtest, optimizer, benchmark, cash pool, performance
   chart or allocation decision.
5. An LLM-derived value that alters deterministic scoring, promotion, position
   sizing, exits or live execution.

## 8. Single Riskiest Assumption

The riskiest assumption is that a richer research surface produces a better
strategy rather than better-looking overfit results. The remedy is immutable
experiment lineage, point-in-time evidence, market-local walk-forward
validation, realistic costs/taxes, minimum sample/confidence floors, and
promotion gates that default to no change.

## 9. Document Authority and Product Direction

This audit is an intake record, not an implementation spec. Before any approved
build, consolidate its accepted decisions into
`features/external-research-integrations/FEATURE_ARCHITECTURE.md`; that file is
the sole implementation authority. No implementer should reconcile this audit,
the repository catalog, or the Vibe deep-dive into requirements independently.

Kairos should be the trusted trading operating system, not a catalogue of quant
packages. Its differentiator is that every recommendation, evaluation and
eventual trade can be traced to governed evidence, a versioned formula, a
market-local portfolio record and an owner-visible approval state.

For full Vibe-specific detail and exclusions, read
`VIBE_TRADING_CAPABILITY_DEEP_DIVE.md`. For the complete 25-repository intake
record, read `REPOSITORY_CAPABILITY_CATALOG.md`.
