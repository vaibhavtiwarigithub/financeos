# Vibe-Trading Deep Capability Map And Kairos Adoption Plan

> Status: **DRAFT FOR CLAUDE + OWNER REVIEW. DESIGN ONLY.**
> Reviewed upstream: [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)
> Pin reviewed: `6fc038d37f1767ae429bab435654b9b425ae66f4` on `main`, 2026-07-14
> Upstream license reported: MIT. Exact pin, dependency lock, and source behavior
> must still be re-reviewed before any source reuse or runtime admission.
> Scope: a deeper capability inventory than the short Vibe card in
> `REPOSITORY_CAPABILITY_CATALOG.md`. This is not a source-code security audit,
> installation approval, or implementation plan.

## 1. Corrected Assessment

The earlier catalog card was **correct but intentionally narrow**: it described
the safest first integration, an advisory research committee. It did not capture
Vibe's full useful surface.

Vibe is not just a multi-agent trading chat. Its current repository includes:

- a hypothesis registry and strategy-development lifecycle;
- a research-autopilot chain from hypothesis to deterministic backtest/report;
- a large alpha/factor library and factor benchmarking;
- multi-engine, market-specific backtesting including India equity;
- post-backtest attribution, correlation, validation, and portfolio optimization;
- trade-journal behavior analysis and counterfactual Shadow Account reports;
- reusable reports/run cards, TradingView Pine/TDX/MetaTrader exports, and
  research delivery/scheduling; and
- broad data, broker, MCP, file, web, persistent-memory, shell, and agent tools.

The first six groups contain meaningful product and research ideas for Kairos.
The final group is also why Vibe must remain outside Kairos's trusted runtime.

## 2. Decision Summary

| Vibe capability group | Kairos decision | Why |
|---|---|---|
| Hypothesis registry + invalidation/decay lifecycle | `build_ourselves` | Directly strengthens the current strategy/learner lifecycle without external runtime risk |
| Run cards, experiment-lineage extension, validation diagnostics | `build_ourselves` | Extend existing `experiment_runs` and reference Router/decision evidence; do not create a parallel proof layer. |
| Alpha Zoo / factor bench | `reference_then_selective_native` | A hypothesis catalog, not 461 factors to import |
| Backtest attribution and statistical diagnostics | `build_ourselves` | Sharpens existing validation; must use Kairos PIT data and market-local benchmarks |
| Portfolio optimizer ideas | `later_native_feature` | Useful after allocation/risk evidence, but cannot replace mandates/risk caps |
| Trade Journal + Shadow Account | `later_native_feature` | Strong user value; use Kairos ledger and account provenance |
| Pine Script export | `later_native_feature` | Valuable because Vaibhav has TradingView Pro; export only validated specs |
| Research committees/swarms | `deferred_external_candidate` | Product value, but first untrusted LLM compute boundary |
| Data loaders/fallbacks | `do_not_integrate` | Canonical Evidence Router already owns this and is currently in shadow proof |
| Broker/MCP/trading connectors | `do_not_integrate` | Adds a competing real-account money path |
| Shell/file/web/MCP client tools, user-created skills, persistent memory | `do_not_integrate` | Excess privilege and prompt/supply-chain risk for Kairos |
| UI/CLI/server runtime | `reference_only` | Wrong product shell; borrow interaction ideas clean-room only |

## 3. High-Value Capabilities To Build In Kairos

### 3.1 Strategy Development Manager: the strongest missed capability

Vibe's current strategy-development skill registers research-derived
factors/strategies, stores artifacts, and monitors information-coefficient and
Sharpe decay through an active -> monitoring -> decayed -> disabled lifecycle.

### What Kairos should build

Extend the existing strategy lifecycle rather than create a parallel registry:

```text
research hypothesis
  -> feature/strategy proposal
  -> deterministic validation
  -> shadow_paper
  -> champion (owner promotion)
  -> monitoring
  -> degraded / quarantined / retired
```

For every strategy/factor proposal, record:

- hypothesis, economic rationale, falsifiers, and source evidence references;
- exact `EvidenceEnvelope`/dataset hash, market, currency, mandate, benchmark,
  cost/slippage model, and feature/strategy version;
- validation fold stability, alpha, information ratio, drawdown, turnover,
  correlation, and sample sufficiency;
- monitoring windows and a conservative decay condition; and
- owner decision, disable reason, and no-deletion historical record.

### What not to copy

Do not copy Vibe's local artifact store, automatic skill writer, raw factor code,
or auto-registration mechanics. Kairos has `strategy_versions`, validation,
shadow state, `decision_observations`, and append-only ledgers; build the missing
lifecycle fields and views on those foundations.

### Why this ranks first

It is Kairos-owned, improves learning integrity, works with deterministic code,
and has no requirement for untrusted compute. It should precede a Vibe committee.

### 3.2 Alpha Zoo: use as a gated hypothesis catalog, not a library import

Vibe exposes 461 factors across Qlib, Alpha101, GTJA, academic, and
PIT-fundamental families, with one-line IC benchmarking and statuses such as
alive/reversed/dead.

### What Kairos should take

- A **Factor Candidate Catalog** with a small initial list of economically
  explainable, market-appropriate candidates.
- A factor admission template: formula semantics, universe, timing, required
  evidence intents, expected direction, correlation hypothesis, cost/turnover
  expectation, and falsifier.
- An IC/decay report over point-in-time Kairos data, market-local only.

### Admission rules

1. Do not import all factors or add them to the score.
2. Start with one candidate at a time and measure only.
3. A candidate must have available point-in-time fields for the target market.
4. It must pass data-quality, leakage, correlation, turnover, walk-forward, and
   sample-size gates before it can enter a challenger strategy.
5. A poor factor is retained as a negative result, not silently removed.

### What not to take

Do not copy factor formulas, code, names, comments, tests, or generated alpha
files. This is clean-room reference work. Vibe's factor count is an idea catalog,
not proof of alpha for Kairos's US/India universe.

### 3.3 Backtest diagnostics and attribution

Vibe's backtest/report layer includes benchmark context, correlation, turnover,
walk-forward validation, Monte Carlo/permutation analysis, beta/regime
attribution, and multi-market engines.

### What Kairos should build

Enhance the existing deterministic Validation Engine and Performance Truth Layer
with a versioned **Experiment Diagnostics** artifact:

| Diagnostic | Kairos use | Required guard |
|---|---|---|
| Benchmark excess / information ratio | Existing benchmark-alpha measurement | Per-market book/benchmark/currency matching and confidence floors |
| Turnover and modeled friction | Capital rotation/strategy evaluation | Native market costs; no generic cross-market rates |
| Fold stability | Promotion evidence | Purged/embargoed chronological folds; no single-fold pass |
| Beta / regime attribution | Explain why performance occurred | Advisory diagnosis, never a direct weight mutation |
| Monte Carlo / permutation | Assess whether apparent edge is fragile | Clear null hypothesis, deterministic seed, minimum sample |
| Correlation / exposure overlap | Avoid duplicate factors/positions | Market-local return windows and existing caps |
| Data coverage / leakage audit | Prove input integrity | Router provenance, PIT facts, and sealed replay accessor |

### What not to take

Do not adopt Vibe's composite cross-market engine. Kairos's US/USD and India/INR
pools must not share capital or be cross-summed. Do not accept an upstream
backtest report as promotion evidence; Kairos recomputes from its own snapshot.

### 3.4 Portfolio Studio ideas

Vibe offers equal-volatility, mean-variance, max-diversification, risk-parity,
and turnover-aware optimizers, plus correlation/risk analysis.

### What Kairos should take later

- Portfolio construction recommendations that explain constraint trade-offs.
- A market-local correlation/exposure view.
- Turnover-aware rebalancing diagnostics.
- Compare allocation alternatives in paper/shadow before any action.

### Kairos boundary

This extends the existing mandates, holding-risk analytics, allocation controls,
capital-rotation safeguards, and broker gates. It must not replace concentration,
sector, name, drawdown, tax, minimum-hold, or owner-approval controls. Initial
mode is advisory/shadow; any paper execution needs its own approved architecture.

### 3.5 Trade Journal and Shadow Account

Vibe can parse broker journals, infer behavioral patterns, extract rules from
history, and backtest counterfactual Shadow Account paths, including missed
signals and early exits.

### What Kairos should build

- A **Decision Review / Counterfactual** view over Kairos `trade_decisions`,
  `paper_trades`, `decision_observations`, and immutable order events.
- Behavior diagnostics with explicit confidence: disposition behavior, chasing,
  overtrading, anchoring, and deviation from declared mandate.
- Counterfactuals for a *named and deterministic* alternative only: e.g. "what
  if this validated stop/target/time-stop rule had been followed?"
- A clear distinction between historical fact, model replay, and speculation.

### What not to take

Do not infer executable trading rules from opaque broker exports or auto-generate
new strategy code. Any extracted pattern is a hypothesis and must enter the
existing validation/shadow lifecycle.

### 3.6 TradingView Pine export

Vibe exports strategy indicators to Pine Script, TDX, and MetaTrader. Pine is
especially valuable because Kairos already has a manual TradingView Pro workflow.

### What Kairos should build

Export a **versioned, read-only Pine v6 research artifact** for an owner-selected,
validated Kairos strategy specification:

- strategy/factor version, market, and intended symbol class;
- exact formula parameters, timing convention, and unavailable-data behavior;
- explicit alert that TradingView results are independent research, not Kairos
  promotion evidence unless the input dates, costs, universe, and output are
  recorded and reproducible in Kairos; and
- no broker/alert-webhook/order code in the generated script.

This lets Vaibhav use TradingView's visual/backtest tooling without giving it
control over Kairos, and without accepting a TradingView test as an automatic
live-trading decision.

## 4. High-Value Capability To Defer: Research Committee

Vibe has 30 swarm presets spanning investment, quant, risk, macro, allocation,
and value-investing workflows. This is useful for adversarial reasoning, but its
agent runtime includes skills, tools, memory, file handling, web access, and MCP
configuration. It is the first capability that justifies the separate zero-trust
compute architecture.

### Kairos version, when ready

Do not import 30 teams. Start with two roles only:

| Role | Output | Cannot do |
|---|---|---|
| Research analyst | Evidence-bound thesis + open questions | Fetch data, set score, modify strategy, write a trade |
| Adversarial reviewer | Contradictions, falsifiers, evidence gaps | Override the thesis, score, or gate |

The input is a frozen Router `EvidenceEnvelope` snapshot. The output is a schema
validated advisory artifact, never a market-data request, strategy mutation,
paper fill, proposal, or order.

## 5. Useful Operational Patterns, Not Runtime Features

| Vibe pattern | Kairos use |
|---|---|
| Reproducible run cards with tool trace/citations | Extend research/validation result presentation and audit links |
| Hypothesis registry with invalidation notes | Strategy/factor lifecycle documentation |
| Scheduled research with explicit default-off flag | Reinforce existing cron governance and owner-visible schedule state |
| Per-run status and report library | Improve experiment/research visibility, not agent autonomy |
| Data-quality OHLC guards | Confirm the Router/normalization layer has equivalent invariant tests |
| Backtest sandbox tests | Requirements for the future GitHub Actions compute container, not a reason to run upstream code |
| Security hardening checklist | Input to future source review, not a trust grant |

## 6. Capabilities Kairos Must Not Use From Vibe

| Vibe surface | Why excluded |
|---|---|
| Broker connectors, Robinhood/Alpaca/other order path, TAP mode | Kairos already has broker-specific gates, accounts, audit, and approval flow; a second execution path is unacceptable |
| Direct data loaders/fallback chains | Router Phase 2 owns provider policy, pacing, cache, evidence provenance, and market support |
| Cross-market composite capital/backtests | Violates Kairos per-market/currency pool isolation |
| Generic external MCP client configuration | User-configured tool endpoints would bypass code-owned allowlists and expand SSRF/credential exposure |
| Shell, file-writing, skill-writing, web reader, arbitrary code generation | Too much authority and prompt/supply-chain attack surface |
| Persistent local memory and Docker volumes | Not Kairos's audit/RLS/retention model |
| Auto-generated strategy code | Breaks the whitelisted feature grammar and deterministic validation boundary |
| Vibe UI/server/CLI as an embedded surface | Duplicates the product shell and data truth layer |

## 7. Sequencing After Router Cutover

The Router must first collect shadow evidence, pass the entry-eligibility-flip
guard, and complete the controlled research cutover. Do not begin Vibe work while
that serial gate is active.

After cutover, the recommended order is:

1. **Strategy/factor lineage and decay monitoring** built natively on existing
   Kairos strategy and validation records.
2. **Experiment Diagnostics** built natively: fold stability, turnover, regime/
   beta attribution, coverage, and conservative statistical checks.
3. **Pine export** for validated research specifications, because it improves the
   current TradingView Pro workflow without adding trust or account risk.
4. **Decision Review / Counterfactuals** based on Kairos's own ledgers.
5. **Portfolio Studio advisory layer** after allocation/risk evidence is mature.
6. **Two-role Vibe-style research committee** only after the future isolated
   compute boundary is independently approved and source reviewed.

## 8. The Actual Vibe Value To Kairos

Vibe's best contribution is not its agent count or its broker support. It is the
discipline of making research produce durable, inspectable artifacts:

```text
hypothesis -> deterministic test -> diagnostics -> run card -> monitoring -> retirement
```

Kairos already owns the more difficult parts: market isolation, real-account
boundary, owner approval, Performance Truth, evidence provenance, and strategy
promotion governance. The best path is to use Vibe as a rich product/research
blueprint and selectively reproduce the high-value parts inside those Kairos
controls. No repository dependency is required for the first five steps above.

## 9. Required Future Review Before Any Vibe Runtime Admission

Before any Vibe source, package, container, or skill is used at runtime:

1. Re-pin an exact release/commit and verify the MIT license and all transitive
   dependency licenses.
2. Perform source-level adversarial review of network, subprocess, filesystem,
   environment, tool, logging, and credential paths at that pin.
3. Build a minimal adapter rather than deploy the Vibe server/UI/agent stack.
4. Run it only in the approved future GitHub Actions `--network none` compute
   container; the trusted wrapper, not Vibe, owns callback credentials.
5. Prove synthetic tests for no egress, no secrets, no money-path reachability,
   schema rejection, timeout/resource limits, disable/rollback, and US/India
   isolation.
6. Admit it as research-only first. Human conversion plus existing Kairos
   validation/shadow gates remain mandatory.
