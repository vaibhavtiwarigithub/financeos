# External Repository Capability Catalog

> Status: **DRAFT FOR CLAUDE + OWNER REVIEW. DESIGN ONLY.**
> Date: 2026-07-14
> Scope: the 25 unique repositories examined from the GitHub `fintech` and
> `quantitative-finance` topic top lists on 2026-07-13: 17 single-repository
> cards, 3 repositories in Section 4.18, Tushare in Section 4.19, and 4
> repositories in Section 4.20.
> Purpose: state exactly what capability, if any, Kairos should take from each
> repository and the safe integration boundary. This is not a claim that any
> repository is production-safe or fully source-audited.

## 1. How To Read This Catalog

Every entry has one of five decisions:

| Decision | Meaning |
|---|---|
| `build_ourselves` | Kairos should implement a small, native capability using its own contracts and tests. No source import. |
| `reference_only` | Learn from the design/methodology; do not depend on or copy runtime code. |
| `deferred_candidate` | Potential future integration only after a specific problem, source audit, license review, and the isolated-compute architecture are approved. |
| `later_product_idea` | Potential UX/product inspiration, not trading-system infrastructure. |
| `do_not_integrate` | Wrong domain, wrong stack, unacceptable scope, or would weaken Kairos controls. |

The evidence-rated adoption recommendations for serious candidates are in
`DEEP_CANDIDATE_CAPABILITY_AUDIT.md`.

This catalog is intake evidence only. `FEATURE_ARCHITECTURE.md` is the sole
implementation authority after owner approval.

No decision in this catalog authorizes installation, a package update, a fork,
credentials, a new data source, a broker scope, or a code change.

### Clean-room rule for `reference_only`

`reference_only` means learn from public concepts, papers, documentation, and
observable behavior, then independently design and implement a Kairos solution.
Do not copy code, notebooks, tests, source structure, identifiers, comments, or
nontrivial expression from a reference repository. This applies especially to
ML4T, Qbot, myhhub/stock, and any GPL-family or license-uncertain project. If
source reuse is ever proposed, it leaves `reference_only` and requires an exact
license, provenance, and legal/product review first.

### Non-negotiable boundary

All candidate capabilities must remain downstream of the **Canonical Evidence
Router** and upstream of Kairos's existing deterministic validation system.
They never receive a broker token, broker MCP tool, vault access, service-role
credential, user session, direct provider authority, or order/proposal write
permission.

```text
Evidence Router -> frozen EvidenceEnvelope + universe -> advisory/derived artifact
    -> Kairos validation/shadow -> owner-controlled champion lifecycle
    -> existing PaperTrader/Execution Gateway
```

There is no arrow from a repository capability to a paper fill, live proposal,
or broker.

## 2. Current Kairos Coverage

The current Router Phase 2 work already covers several gaps that outside projects
appear to solve:

| Kairos capability | Current state | External projects that are no longer needed for it |
|---|---|---|
| Provider adapter registry, typed contracts, policy, cache, ledger, pacing, health | Implemented shadow-only with `router_enabled=false`; live evidence is accumulating | OpenBB architecture, daily_stock_analysis data abstraction, Qbot data plumbing |
| Provider policy UI | Settings -> Data routing policy/health surface implemented, not yet scoring-active | OpenBB Workspace/terminal-style data selection concepts |
| Deterministic score, strategy governance, validation, shadow lifecycle | Kairos-owned and market-local | FinRL/Qlib/strategy collections cannot replace it |
| Benchmark alpha and capital-rotation controls | Kairos-owned; benchmark P1 and rotation P1 remain gated/off where designed | Generic backtest/trading platforms |
| Paper/live separation, account isolation, final order gates | Kairos-owned | Every repository in this catalog |

The Router's current shadow result is evidence that the integration architecture
is working, not evidence that a new provider or repository should be activated.
Scoring cutover stays blocked until shadow parity and the eligibility-flip guard
are complete.

## 3. Recommended Capability Portfolio

| Priority | Capability | Source inspiration | Kairos decision | Earliest gate |
|---|---|---|---|---|
| 1 | Canonical data/source routing | OpenBB concepts, existing Kairos Router | Continue Kairos-owned Router; no OpenBB runtime | Router shadow parity + eligibility-flip guard |
| 2 | Technical-indicator semantic parity | TA-Lib | Build only the needed 6-10 formulas as pure, tested TypeScript if a demonstrated gap exists | After Router cutover evidence; no scoring change by default |
| 3 | Experiment and model governance | Qlib + ML4T methodology | Reference-only; evolve current validation engine selectively | Enough mature, market-local observations |
| 4 | Research committee/adversarial critique | Vibe-Trading | Deferred advisory-only candidate | Future isolated compute review + exact release audit |
| 5 | Financial-language research enrichment | FinGPT | Deferred research-only candidate, not a scorer | Clear incremental evidence beyond current news/evidence model |
| 6 | Portfolio explanation/import UX | Ghostfolio + AI Berkshire concepts | Later product idea | After truth-layer and live-account surfaces stabilize |

Nothing from this table is a next implementation task while Router shadow evidence
is accumulating. The immediate work is serial: observe shadow results, build the
eligibility-flip guard, then decide on controlled Router cutover.

## 4. Detailed Candidate Cards

### 4.1 Vibe-Trading

> Detailed capability map and Kairos adoption boundaries:
> `features/external-research-integrations/VIBE_TRADING_CAPABILITY_DEEP_DIVE.md`.

- **Repository:** [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)
- **Observed capabilities:** declarative research-team workflows, specialist
  roles, adversarial synthesis, hypothesis-to-backtest evidence flow, document
  ingestion, TradingView/Pine-oriented export, behavioral trade journals,
  counterfactual/shadow analysis, attribution, and run artifacts.
- **Decision:** `deferred_candidate`.
- **What Kairos should take:** a small `Research Committee` concept: one
  bounded hypothesis artifact plus one structured adversarial critique. Also use
  its artifact/run ideas to improve explainability of experiment outcomes.
- **Do not take:** its multi-agent runtime, broad tool access, autonomous
  research/data collection, direct strategy execution, or a large team graph.
- **Safe contract:** input is a one-market frozen `EvidenceEnvelope` snapshot;
  output is `hypothesis` or `critique` only. A human must convert it into a
  Kairos feature-registry proposal, which then uses the existing whitelist and
  Validation Engine.
- **Security/license gate:** review the exact pinned release, license, dependency
  lock, network/subprocess behavior, prompt-injection handling, and any upstream
  data-tool assumptions before installation or code reuse.
- **Earliest phase:** future isolated-compute Phase 3, after Router cutover is
  proven and only if the manual workflow demonstrates durable value.

### 4.2 TA-Lib Python

- **Repository:** [TA-Lib/ta-lib-python](https://github.com/TA-Lib/ta-lib-python)
- **Observed capabilities:** standardized technical-analysis indicators and
  candlestick/pattern functions backed by a native library.
- **Decision:** `build_ourselves` for the small subset Kairos needs now;
  `deferred_candidate` for native TA-Lib only if there is a demonstrated
  semantic/performance gap.
- **What Kairos should take:** named formula versions, explicit warm-up rules,
  fixed adjustment basis, and golden numerical fixtures for the few indicators
  actually used in scoring/validation.
- **Do not take:** a native dependency or worker merely to calculate RSI, MACD,
  ADX, moving averages, ATR, or similar small deterministic formulas.
- **Safe contract:** pure TypeScript function over already normalized,
  point-in-time Kairos bars; returns an indicator artifact, not a recommendation.
- **Security/license gate:** standard dependency/license/SBOM review if native
  TA-Lib is ever proposed. It never gains provider, broker, or account access.
- **Earliest phase:** only after Router shadow/cutover evidence identifies a real
  technical-data inconsistency. No scoring or trade behavior changes by default.

### 4.3 Qlib

- **Repository:** [microsoft/qlib](https://github.com/microsoft/qlib)
- **Observed capabilities:** quant data/feature pipelines, dataset handling,
  experiment recording, model workflow, and portfolio/backtest research patterns.
- **Decision:** `reference_only` now; possible `deferred_candidate` only for a
  future offline model-research program.
- **What Kairos should take:** experiment lineage, dataset versioning, feature
  provenance, run comparison, and reproducibility expectations.
- **Do not take:** Qlib as Kairos's data system, strategy lifecycle, portfolio
  allocator, or execution engine. Those would duplicate the Evidence Router,
  Performance Truth Layer, and market-local governance.
- **Safe contract if reconsidered:** offline benchmark artifact against frozen
  decision-observation snapshots; Kairos Validation Engine remains the pass/fail
  authority.
- **Earliest phase:** after sufficient market-local matured observations, stable
  Router provenance, and an owner-approved statistical-model architecture.

### 4.4 Machine Learning for Trading

- **Repository:** [stefan-jansen/machine-learning-for-trading](https://github.com/stefan-jansen/machine-learning-for-trading)
- **Observed capabilities:** educational, end-to-end examples from data sourcing
  through trading research and machine-learning experimentation.
- **Decision:** `reference_only`.
- **What Kairos should take:** validation test cases and research-methodology
  checks: leakage resistance, temporal splits, realistic costs, benchmark-aware
  evaluation, and experiment reproducibility.
- **Do not take:** notebook code, data paths, a runtime dependency, or a trading
  engine.
- **Earliest phase:** immediately as review/test inspiration; no integration
  runtime is needed.

### 4.5 OpenBB

- **Repository:** [OpenBB-finance/OpenBB](https://github.com/OpenBB-finance/OpenBB)
- **Observed capabilities:** provider-agnostic data integration exposed to Python,
  APIs, MCP, workspaces, and other consumers through a connect-once pattern.
- **Decision:** `reference_only`.
- **What Kairos should take:** capability registry, typed provider adapters,
  normalized output contracts, health/entitlement visibility, and separation of
  data access from consuming surfaces.
- **Current Kairos coverage:** Router Phase 2 already implements the relevant
  ownership model: intent catalog, typed adapters, policy, durable cache/ledger,
  pacing, health, and owner UI.
- **Do not take:** its code or runtime. The reviewed repository states AGPLv3,
  which requires a separate legal/product decision even for non-money-path use.
- **Earliest phase:** none unless that separate license decision is approved.

### 4.6 FinGPT

- **Repository:** [AI4Finance-Foundation/FinGPT](https://github.com/AI4Finance-Foundation/FinGPT)
- **Observed capabilities:** finance-oriented language-model research,
  fine-tuning/instruction patterns, and finance-text task framing.
- **Decision:** `deferred_candidate` for research enrichment only.
- **What Kairos should take:** structured extraction/evaluation ideas for news,
  filings, and research summaries, with explicit evidence citations.
- **Do not take:** a finance LLM as a score calculator, direction selector,
  strategy optimizer, or order authority. Do not import weights/datasets without
  privacy, license, model-cost, and prompt-injection review.
- **Safe contract:** text-to-structured advisory artifact with citations to
  supplied evidence; deterministic Kairos code controls every numeric decision.
- **Earliest phase:** only after the existing evidence/research journal shows a
  measurable extraction gap.

### 4.7 FinRL

- **Repository:** [AI4Finance-Foundation/FinRL](https://github.com/AI4Finance-Foundation/FinRL)
- **Observed capabilities:** reinforcement-learning-oriented trading research and
  environments.
- **Decision:** `reference_only` / `do_not_integrate` into the current app.
- **What Kairos should take:** awareness of simulation assumptions and the need
  for strict out-of-sample validation before claiming an automated policy edge.
- **Do not take:** an RL agent, simulator, trained policy, or automated allocator.
  The data volume, regime stability, reward-design, reproducibility, and safety
  burden do not fit current single-user US/India evidence.
- **Earliest phase:** no planned phase.

### 4.8 daily_stock_analysis

- **Repository:** [ZhuLinsen/daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis)
- **Observed capabilities:** multi-source market/news collection, LLM-driven
  daily analysis, dashboard/notifications, scheduled runs, and strategy folders.
- **Decision:** `reference_only`.
- **What Kairos should take:** operational ideas for health visibility, scheduled
  report delivery, and a clear distinction between source availability and a
  rendered report.
- **Current Kairos coverage:** Router health, durable queue, prewarm, shadow cron,
  and Research Journal already provide the more governed equivalents.
- **Do not take:** scraping/cookie/proxy approaches, LLM-decided signals,
  data-provider assumptions, or auto-trading examples.
- **Earliest phase:** no runtime integration.

### 4.9 AI Berkshire

- **Repository:** the `ai-berkshire` project reviewed in the FinTech scan. The
  exact upstream URL/commit must be re-verified before any source-level review;
  this catalog does not substitute a similarly named repository.
- **Observed capabilities:** multi-agent investment-research framing and
  explainable, persona-based portfolio analysis.
- **Decision:** `later_product_idea` / `reference_only`.
- **What Kairos should take:** plain-language investment memos that distinguish
  supporting evidence, counterarguments, uncertainty, and decision ownership.
- **Do not take:** simulated analyst personas as a source of numeric conviction,
  a portfolio manager, or a direct market-data/execution pipeline.
- **Safe fit:** Research Journal explanation layer only, using Kairos evidence and
  clearly labelled as advisory.
- **Earliest phase:** after Router cutover and only as a UX/research-journal
  improvement.

### 4.10 QuantDinger

- **Repository:** [QuantDinger/QuantDinger](https://github.com/QuantDinger/QuantDinger)
- **Observed capabilities:** broad quant-system/project architecture and trading
  workflow patterns.
- **Decision:** `reference_only`.
- **What Kairos should take:** review prompts/checklists for data, experiment,
  risk, and operational observability.
- **Do not take:** runtime orchestration, credentials model, broker integration,
  or a separate trading database.
- **Earliest phase:** no runtime integration.

### 4.11 Ghostfolio

- **Repository:** [ghostfolio/ghostfolio](https://github.com/ghostfolio/ghostfolio)
- **Observed capabilities:** portfolio tracking, imports, reporting, privacy, and
  consumer portfolio UX.
- **Decision:** `later_product_idea`.
- **What Kairos should take:** import-review, history reconciliation, privacy
  display, account-level explanation, and portfolio-report UX ideas.
- **Do not take:** its portfolio valuation/accounting model as Kairos truth;
  Kairos must preserve account, broker, market, currency, and ledger provenance.
- **Earliest phase:** after live portfolio/reconciliation surfaces are stable.

### 4.12 FinceptTerminal

- **Repository:** [Fincept-Corporation/FinceptTerminal](https://github.com/Fincept-Corporation/FinceptTerminal)
- **Observed capabilities:** dense terminal-style financial research/workspace
  interface.
- **Decision:** `later_product_idea`.
- **What Kairos should take:** scan-friendly research layout, evidence drill-down,
  and keyboard-efficient workspace patterns where they fit Kairos's novice-first
  product behavior.
- **Do not take:** terminal code, external data integrations, or execution model.
- **Earliest phase:** UI-only, after data/truth surfaces settle.

### 4.13 Qbot

- **Repository:** [UFund-Me/Qbot](https://github.com/UFund-Me/Qbot)
- **Observed capabilities:** broad open-source quant research/trading project with
  data, strategy, and workflow examples.
- **Decision:** `reference_only`.
- **What Kairos should take:** comparison checklist for modular research, data
  adapters, and strategy experiment concerns.
- **Do not take:** broad framework code, broker/data connectors, scraper logic,
  or bundled strategies.
- **Reason:** it overlaps with the Router and Validation Engine while providing
  weaker Kairos-specific market, audit, and money-path isolation.

### 4.14 vn.py

- **Repository:** [vnpy/vnpy](https://github.com/vnpy/vnpy)
- **Observed capabilities:** event-driven trading platform with exchange/broker
  connectivity and strategy infrastructure.
- **Decision:** `do_not_integrate`.
- **What Kairos should take:** nothing at runtime; its event-driven separation can
  be an occasional architecture reference.
- **Reason:** wrong stack/domain and a competing execution architecture. Adding it
  would expand rather than reduce the real-account attack surface.

### 4.15 StockSharp

- **Repository:** [StockSharp/StockSharp](https://github.com/StockSharp/StockSharp)
- **Observed capabilities:** .NET algorithmic-trading platform, broker/exchange
  connectivity, trading robots, and strategy tooling.
- **Decision:** `do_not_integrate`.
- **Reason:** wrong language/runtime and a parallel execution platform. No
  capability outweighs the additional account, broker, and reconciliation risk.

### 4.16 myhhub/stock

- **Repository:** [myhhub/stock](https://github.com/myhhub/stock)
- **Observed capabilities:** China-market screening, technical indicators,
  patterns, backtesting, automation, and broad daily data collection.
- **Decision:** `do_not_integrate`.
- **What Kairos should take:** only the reminder to make formula basis and
  screening conditions explicit/testable.
- **Reason:** China-market data assumptions, scraping/cookie/proxy patterns, and
  auto-trading scope do not fit Kairos US/India/provider policy.

### 4.17 je-suis-tm/quant-trading

- **Repository:** [je-suis-tm/quant-trading](https://github.com/je-suis-tm/quant-trading)
- **Observed capabilities:** a collection of technical/CTA/options/pairs and
  rule-based strategy examples.
- **Decision:** `reference_only`.
- **What Kairos should take:** a hypothesis catalog only. Each idea must become a
  formally specified, point-in-time, cost-aware candidate before validation.
- **Do not take:** strategy code, parameter defaults, performance claims, or a
  buy/sell rule.

### 4.18 awesome-quant, financial-machine-learning, awesome-systematic-trading

- **Repositories:** [awesome-quant](https://github.com/wilsonfreitas/awesome-quant),
  [financial-machine-learning](https://github.com/firmai/financial-machine-learning),
  [awesome-systematic-trading](https://github.com/paperswithbacktest/awesome-systematic-trading)
- **Observed capabilities:** curated discovery lists of libraries, papers, tools,
  and systematic-trading resources.
- **Decision:** `reference_only`.
- **What Kairos should take:** a quarterly external-research intake list. Each
  linked project starts at `proposed` and must independently pass the same
  license/security/capability review.
- **Do not take:** any list item implicitly; list inclusion is not validation.

### 4.19 Tushare

- **Repository:** [waditu/tushare](https://github.com/waditu/tushare)
- **Observed capabilities:** China-market financial data access.
- **Decision:** `do_not_integrate`.
- **Reason:** it does not solve a current US/India gap and would add a separate
  provider entitlement, quota, and market-data compliance surface.

### 4.20 Hyperswitch, Lago, Akaunting, blockchain_guide

| Repository | Decision | Reason |
|---|---|---|
| [Hyperswitch](https://github.com/juspay/hyperswitch) | `do_not_integrate` | Payments orchestration, unrelated to trading/research. |
| [Lago](https://github.com/getlago/lago) | `later_product_idea` | Only relevant if Kairos becomes a multi-user paid SaaS with metering/billing. |
| [Akaunting](https://github.com/akaunting/akaunting) | `do_not_integrate` | General accounting, not the portfolio/performance truth layer. |
| [blockchain_guide](https://github.com/yeasy/blockchain_guide) | `reference_only` | Educational discovery only; no current US/India trading capability. |

## 5. Integration Recipes For The Few Candidates Worth Revisiting

### Recipe A - Vibe-derived Research Committee

**Problem it solves:** Kairos wants a disciplined second opinion on a research
thesis, not more autonomous agents.

**Inputs:** one market, one frozen Evidence Router snapshot, bounded owner
question, current Research Journal context, and no account/position data.

**Outputs:**

```ts
type ResearchCommitteeArtifact = {
  thesis: string;
  supportingEvidenceRefs: string[];
  counterEvidenceRefs: string[];
  falsifiers: string[];
  unansweredQuestions: string[];
  dataCoverage: "sufficient" | "partial" | "insufficient";
};
```

**Kairos action:** display as advisory; owner may create a feature-registry
proposal manually. It never creates a strategy version or signal by itself.

### Recipe B - Technical Formula Parity

**Problem it solves:** a known semantic mismatch between a current provider value
and a score/backtest requirement.

**Inputs:** router-normalized daily bars with one price-adjustment basis.

**Output:** versioned pure TypeScript indicator result plus warm-up/coverage flag.

**Kairos action:** compare to existing provider calculation in shadow first. A
scoring change requires its own feature architecture and validation evidence.

### Recipe C - Qlib-Inspired Experiment Lineage

**Problem it solves:** comparing multiple candidate models/features without losing
dataset and feature provenance.

**Inputs:** existing `decision_observations`, matured labels, router policy/
snapshot hash, strategy version, mandate, benchmark configuration.

**Output:** an extension to Kairos's existing validation artifact, not a Qlib run.

**Kairos action:** existing validation/promotion gates retain authority.

## 6. Common Intake Gate For Any Future Repository

Before adding a new entry beyond this catalog:

1. State the Kairos problem it solves and why current components cannot solve it.
2. Classify it as product inspiration, reference, native implementation,
   deferred external candidate, or prohibited.
3. Record exact release/commit, license, dependency lock, owner, and source URL.
4. Read source for install scripts, dynamic loading, subprocess use, filesystem
   access, telemetry, credentials, network calls, and data/broker assumptions.
5. Define the narrow `EvidenceEnvelope`-based input and artifact output.
6. Prove no money-path, account, vault, provider, or broad database authority.
7. Test synthetic fixtures first; then research-only/shadow; then evaluate value.
8. Pin the approved release and require manual review for every upstream update.

## 7. What The Catalog Does Not Approve

- Any repository installation or package dependency.
- A new GitHub Actions workflow or worker.
- Any source copy, fork, or vendor import.
- Any provider/broker credential, account access, MCP tool, or direct database
  permission for an external capability.
- A scoring, sizing, paper-trading, rotation, learner, or live-trading change.
- Router Phase 4 cutover before shadow parity and the eligibility-flip guard.

## 7b. Explicit Build Roadmap — and why NOT all at once

Plain-language version of what "getting these repos working with Kairos" actually
means. For ~20 of the 25 it means **nothing ever runs** — they are read-for-ideas
(`reference_only`), out of scope (`do_not_integrate`), or someday-UX
(`later_product_idea`). Only three ever become Kairos capability, and two of those
are **reimplemented by us, not installed.**

### The three buckets
- **Bucket 1 (~20 repos):** never integrated. Learn or ignore. The Router already
  replaced OpenBB-style data infrastructure; most others are wrong-domain.
- **Bucket 2 (TA-Lib, Qlib):** we write a *small native piece inspired by them* —
  a few TypeScript indicator formulas / experiment-lineage tracking. **Zero source
  copied** (clean-room, per §4). Not an install.
- **Bucket 3 (Vibe-Trading):** the ONLY true external integration — an advisory
  research committee running in the future isolated sandbox. Last, optional, and
  gated behind the sandbox build + source audit.

### Sequence (each step gated on the prior's EVIDENCE — cannot be parallelized)
1. **NOW:** nothing on repos. Router shadow accrues (`kairos-evidence-shadow-*`,
   3 ticks/day/market). *Buildable early: the eligibility-flip guard only.*
2. **Eligibility-flip guard** (Kairos-internal, not a repo): scoring-boundary
   check so a dimension dropping out — for ANY reason, policy OR provider outage —
   cannot renormalize a symbol from ineligible → eligible. Defensive; inert until
   cutover.
3. **Router Phase-4 cutover** (Kairos-internal, not a repo): flip `router_enabled`
   for one market, feed the resolver into scoring, only after shadow proves
   canonical scores match legacy within tolerance.
4. **First real gap only, from shadow data** → Bucket 2, reimplemented natively:
   native formula parity (TA-Lib-inspired) first, then Kairos-owned experiment
   lineage (Qlib-inspired).
5. **Much later, optional:** build the isolated sandbox → try the Vibe advisory
   committee (Bucket 3).

### Why not build all of it now
- **Cutover before shadow parity = the exact score-drift / eligibility-flip bug
  the Router exists to prevent.** Hard no.
- **TA-Lib before the shadow proves a technical gap = fixing a non-problem** and
  risking a scoring change for no reason.
- **Vibe sandbox now = maximum attack surface + large effort for a maybe-never
  capability.**
- Steps 2→5 form an **evidence chain**, not disjoint work. The Router *foundation*
  parallelized because its pieces had no data-dependency; these steps each need the
  prior step's evidence, so parallelizing them defeats the safety gates.

Only step 2 (eligibility-flip guard) is safe to build ahead of cutover, and even it
benefits from a few days of shadow data to calibrate thresholds.

## 8. Recommended Decision

1. Keep the catalog as the authoritative external-project intake record.
2. Let the Router shadow run accumulate evidence; do not add an external project
   during this serial gate.
3. After cutover evidence, reassess only the first real gap. The likely order is:
   formula parity (native Kairos) -> model/experiment lineage improvements
   (Qlib-inspired, Kairos-owned) -> advisory research committee (Vibe candidate).
4. Review this catalog whenever a new GitHub repository is proposed rather than
   treating any new popular project as an app dependency.
