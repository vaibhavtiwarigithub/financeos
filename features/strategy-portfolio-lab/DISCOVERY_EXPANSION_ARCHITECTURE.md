# Existing strategies, combinations, and autonomous discovery

Date: 2026-11-03
Status: owner-approved 2026-11-03 ("finish all pending work"); implementation in progress.
Owner direction: start with existing dimension/strategy knowledge, combine bounded candidates, discover new hypotheses, backtest automatically, and diagnose failure without owner operation of each trial.

## 1. User intention

Give Kairos an automatic, observable research process that tests existing ideas first, learns which families and conditions support them, and proposes genuinely new candidates. The owner should see outcomes and blockers rather than manually start every experiment. No financial benefit is assumed before evidence exists.

## 2. Current architecture and verified production

Reuse Strategy Portfolio Lab, LearnerAgent, the deterministic rule compiler/replay, research observations, matured labels, immutable shadow configurations/events/outcomes, trial-family registry, tournament, paper selector, System Health, and supervisor. Do not build a second backtester or an independent broker agent.

The automatic price-rule release became READY at 2026-10-30 21:10:10 UTC (deployment dpl_5funHD9Tdhv9iZ8HYCWXm3xgeStc, commit d529769d5274d59cf1fba10b29f638c5fa00aa9c). The latest US Learner run began at 21:00:02 UTC and India at 20:30:02 UTC that day; their recorded tools do not include the new catalog/proposal tools. No subsequent Learner run was present at the Nov 3 audit. Thus absence of candidates is not evidence the new discovery loop tried and rejected everything.

Production currently has zero template shadow configurations, decisions, outcomes, paper-selector evaluations, and validation experiments. There is one paper-active strategy version per market. The current automatic proposer supports only seven price-rule keys, at most two conditions, and one optional LLM proposal per weekly market run. It does not implement all-dimension strategy combination discovery. The supervisor prioritizes a queue; it does not execute research repairs or backtests itself.

## 3. Proposed architecture

### Stage A: catalog and capability audit

Build a typed adapter over existing strategy_templates, feature_specs, dimension/formula identities, scoring variants, and strategy versions. Preserve exact source/version, economic hypothesis, applicable market, exposure family, direction, required inputs, horizon, compiler, source availability timestamps, and historical/forward coverage. A dimension score is a feature, not automatically an entry/exit strategy. Each admitted strategy also needs entry timing, exit timing, costs, and comparison contract.

Classify every source as executable historical, forward-only, unsupported grammar, missing data, or reference-only. Never silently drop unsupported template conditions. Inverse and leveraged exposures require explicit mapping and daily-reset/session constraints; do not apply a long-stock rule unchanged or invert every dimension mechanically.

### Stage B: deterministic seeds before novel discovery

Run the catalog adapter on each existing weekly market-local Learner cycle before optional LLM proposals. Start with already compilable reference strategies. Register each attempted candidate and its trial identity before screening, including candidates rejected for data or compiler limitations. Up to six seed diagnostics, four deterministic pair combinations, and one existing-budget LLM proposal per market per weekly cycle are proposed initial ceilings, with a 45-second cached diagnostic budget and resumable worklist. These are workload ceilings, not requirements to manufacture that many strategies. Preserve the current one active forward slot per market.

Use existing cached prices and observed feature snapshots. No extra inference call, schedule, paid source, Supabase upgrade, or unbounded historical fetch is part of this design. An unavailable input defers the affected candidate, leaving a durable reason. The autonomous generator must not depend on the LLM choosing a tool to get basic reference-strategy coverage.

### Stage C: bounded combinations

Predeclare eligible pairs from economically distinct source families. First support AND confirmation and fixed equal-weight normalized score combinations; defer optimized weights and OR entry expansion until separately specified. Standardization parameters are fit on training data only. Each source strategy, pair, threshold, horizon, exposure slice, and revision is a declared trial; canonical fingerprints deduplicate semantically identical combinations. Include every attempted trial in multiplicity accounting, even failed historical screens.

Compare each combination against the unchanged deterministic baseline and each individual parent on identical timestamped opportunities. Report incremental value beyond parents, overlap, turnover, costs, concentration, and sample coverage. Cap the graph depth at two parents in this release. Missing inputs mean unavailable, never neutral or zero. Fundamental/sentiment/insider/macro/council variants use only genuinely retained point-in-time values; historical present-day reconstructions cannot qualify as observed historical inputs.

### Stage D: deterministic replay and failure diagnosis

Reuse the costed next-executable-session replay and its source/basis checks. Freeze development, validation, and final evaluation periods before selecting candidates. Use walk-forward folds with horizon-aware purging and embargo; disclose current-universe selection and adjustment/corporate-action limitations. Benchmark and baseline use the same market, currency, session grid, capital and opportunity set. Missing delisted or historical-membership coverage limits the claim to the declared researched cohort.

Diagnose: unsupported contract; insufficient warmup/history; unavailable or late input; missing benchmark; no qualifying trades; accounting or corporate-action integrity failure; costs/spread sensitivity; negative out-of-sample excess; unstable folds; concentration; overlap; and regime coverage. Every diagnostic separates measured facts from an LLM hypothesis about why they occurred. Do not imply causal explanations from descriptive slices.

Failure is an acceptable terminal result. A malformed collector/compiler may be repaired and replayed on a new code version with the original result retained. A strategy that fails an evaluation set cannot be tuned on that set and called independently validated. A revised hypothesis has a new parent-linked identity and trial count; it needs untouched later data. Limit automatic statistical revisions to one child per parent per weekly cycle and two children per research epoch. Exhaustion parks that branch with a reason.

### Stage E: new hypotheses and contextual applicability

The existing Learner model receives the versioned catalog, supported input coverage, development-only diagnostic summaries, unsuccessful attempts and remaining trial budget. It may propose a falsifiable extension in the approved grammar or abstain. Novel arbitrary code is refused. The deterministic scheduler/compiler controls registration, tests and capacity.

Predeclare instrument-family and market-state slices before evaluating them. Prefer pooled family/regime evidence; show symbol-specific trade counts and uncertainty only where supported. Do not claim per-symbol cross-sectional IC or choose the best horizon separately for each symbol without counting those trials. Historical price trend/volatility bins are not equivalent to historical economic regimes.

### Stage F: forward evidence, selection and use

Admit a candidate to the existing forward slot only after data integrity and its declared historical eligibility gate pass. Keep immutable configuration, untouched forward session grid, labels and trial identity. Preserve the existing paired-forward selection thresholds while comparing their portfolio assumptions to the candidate contract. Insufficient evidence keeps collecting; mature failure retires; a passing strategy may affect the already-approved paper ranking preference.

That preference only ranks signals already eligible under the current composite. It does not let a newly discovered strategy originate an otherwise ineligible trade. A future strategy-originated signal adapter requires its own approved entry policy, paired paper portfolio evidence and allowed account mandate before using the common execution kernel. Live adaptation is independently gated; historical fit and LLM confidence cannot activate it.

## 4. User journey / system flow

### Stage G: autonomous dimension data and formula improvement

Owner extension (2026-11-03): include automatic evaluation of every dimension's data sources, input construction, formula and predictive contribution; use existing app LLMs as research assistants within the shared budget. This is additional planned behavior, not a shipped capability.

Use the existing dimension diagnostics, score-variant registry/evaluators, feature_specs, source provenance, LLM call ledger and champion/challenger lifecycle. Keep two explicit objectives: factual data reliability and predictive usefulness. A provider can be factually correct without its field predicting returns. A retrospectively revised dataset can look predictive while being unavailable at decision time. Agreement among vendors is not ground truth when they share an upstream source.

For technical, fundamental, sentiment, insider, macro, council and composite inputs, retain source identity, field definition, instrument/exposure applicability, units/currency, event time, publication/acceptance time, app observation time, revision vintage, freshness, provenance and formula/config version. Audit missing, late, conflicting and outlier values, input-to-score propagation and score-to-return lead/lag separately. Missing or inapplicable values cannot be neutral votes. Compare US/India, ordinary equity/ETF, inverse/leveraged exposure, commodities and crypto under their explicit contracts; an equity filing field must not become an ETF fundamental signal by default.

Use authoritative references where available: original corporate filings/exchange releases for financial facts, source-published methodology and calendars for macro, and the correct venue/feed/session definition for quotes. Record disagreements and unknowns rather than declaring an LLM answer authoritative. ALFRED explicitly archives first releases and revisions; use the actual available vintage for historical macro tests (https://fred.stlouisfed.org/docs/api/fred/alfred.html). SEC provides submissions and XBRL APIs; financial statements must be aligned to their actual public availability, not just fiscal period end (https://www.sec.gov/about/developer-resources). These are candidate/reference capabilities, not claims that a new integration is enabled.

Each improvement is one of: source-only, parsing/normalization-only, formula-only, dimension-weight-only or a declared interaction. First test changes separately against the same frozen observation cohort, then test supported interactions as additional trials. Keep other inputs/formulas fixed for source/formula ablations; report incremental information beyond the current composite to avoid counting duplicate signals twice. Version source policy and formula independently, for example technical formula v2 plus source policy v3. Preserve original historical observations and predictions.

An improvement packet records the reproducible defect or falsifiable hypothesis, exact source/formula diff, required data, target cohort/horizons, baseline, expected failure conditions, trial family, cost/latency budget and rollback trigger. Formula parameters and conditional rules such as MACD crossing below zero versus above zero are separate declared candidates. Fit parameters only on development folds; compare forward and held-out paired IC/spread/calibration, coverage and lag before portfolio replay. Statistical uncertainty, repeated horizons/slices, turnover and execution costs remain explicit. A higher raw IC with worse coverage or later information is not automatically better.

Resource discovery may inspect official documentation and existing licensed provider capability inventories. Existing authorized provider alternatives may be measured within their current entitlements and rate budgets. A new free public source may be proposed with attribution, terms, availability and identity checks; discovery does not authorize signup, new credentials, scraping restricted material, a paid subscription or external data transmission. Source adoption that changes meaning or authority needs versioned evaluation. Equivalent-source failover may restore the documented contract under existing repair authority; it must not silently weaken freshness or factual checks.

### Stage H: existing LLM roles and bounded automatic decisions

Use the existing configured Learner model through callLLM/runAgentLoop to prioritize evidence-backed dimension hypotheses and draft machine-readable challenger packets. Source-auditor, formula-designer and critic are roles in that workflow, not new permanently running agents or guaranteed independent experts. Existing council members may supply a critique only through the approved scheduled research budget and selected available membership; do not multiply calls because more roles are named. Keep the current per-cycle inference ceiling; replacing or sharing a scheduled allocation must be recorded before extra calls occur. Authentication/quota/outage blockers pause optional work and surface in System Health; missing member results never become agreement.

The deterministic services verify source citations/factual fields, compiler allowlists, timestamps, budgets, trial counts, test results, promotion eligibility and rollback conditions. LLM rationales and confidence are explanations, never proof of accuracy. Do not request or store private chain-of-thought; retain concise hypotheses, cited evidence, counterarguments and structured verdicts. Malicious instructions in provider/web documents cannot authorize tools, credentials, code execution or policy changes. The model receives sanitized evidence packets rather than secrets or account details.

Automatic progression should require no owner action per ordinary candidate: inspect -> propose -> validate contract/data -> historical or forward-only measurement -> paired evaluation -> retain/reject/defer -> apply only within the existing approved research/paper adaptation lane. Formula/source-policy promotion beyond the existing dimension-weight/rule-ranking authority needs an explicit adoption contract with atomic version switch, append-only audit, rollback and existing scoring/risk invariants before implementation. Until that contract is approved and proven, formula/source candidates remain measurement-only. Live authority remains independently governed.

### Stage I: accountability and owner visibility

Learning -> Dimension health & regressions shows each dimension's active formula/source version, factual-quality metrics, predictive evidence, current challenger, failure cause, next eligible evaluation and adopted/rejected changes. Symbol Research/fundamental detail shows the actual sources, as-of times, exclusions and formula that produced its score. Agents shows the exact configured model/execution source for each research role and the next/last scheduled cycle. System Health receives broken producers, stale diagnostics, bad data and rollback events. Upgrade Path reports review/eligibility gates and never treats a successful job or a better data-quality score as proof of alpha. Store one deduplicated improvement queue shared with strategy discovery, with safety/data repairs ahead of statistical experiments.

Acceptance additions: a deliberately wrong unit/source timestamp is detected without interpreting later returns; a provider-only comparison freezes the formula; a formula-only comparison freezes inputs; unsuitable dimensions are excluded correctly for instrument exposure; unavailable old data becomes forward-only; revisions count as trials; budget exhaustion and missing council members create explicit outcomes; no formula/source automatically enters a money path through an explanation or health success.

Existing weekly cycle -> capability audit -> reference seeds -> bounded combinations -> optional new LLM hypothesis -> immutable trial registration -> cached historical screen -> failure diagnostics or eligible queue -> existing forward slot -> natural research observations and labels -> deterministic tournament -> governed paper preference or retirement. Every cycle stores an explicit evaluated, deferred, abstained, empty-catalog, disabled, capacity-full, or error outcome. An absent producer run is different from an empty result.

## 5. UI / API / data / interaction model

Learning owns a single strategy-discovery funnel: next/last producer cycle, counts by stage, exact pending reason, and candidate detail. Detail shows source formulas/strategies, versions, combination, trial count, data coverage, chronological folds, net benchmark/baseline/parent deltas, predeclared slices, failures, revisions, untouched-forward maturity, and current authority. Agents owns execution/producer status; Upgrade Path summarizes readiness; Symbol Research displays applicable candidate matches with evidence state. The symbol-detail strategy view is a projection of the existing frozen market-local candidate universe and natural per-symbol shadow ledger: report no matching candidate, no observation, pending label, and descriptive matured result as distinct states; never trigger a per-symbol LLM call or infer a zero score from absent evidence. Candidate-level historical screens must remain separate from that ticker's later forward outcomes, and per-symbol outcomes are descriptive unless the pooled predeclared gates pass. The current initial cohort and compute ceiling remain bounded; this view does not imply all symbols receive an individual backtest. Paper Portfolio explains a selected strategy's contribution to ranking. Reuse existing routes and panels.

Persist cycle summaries and bounded aggregate diagnostics in existing agent_runs workload_metrics. Reuse existing config/event/evaluation tables where their semantics fit. Register historical failures and parent/trial lineage before performance screening; a schema review must establish whether existing ledgers can express these events atomically. Any additive migration requires the normal schema approval and deployment proof. Store no dense transient quote series or full per-symbol fold blobs in Postgres; use already-approved local archive/restore procedures for detailed artifacts, retaining hashes and reproducibility metadata centrally. Local artifacts must be explicitly unavailable to cloud consumers when the PC is offline.

## 6. States and edge cases

No supported seeds is a capability blocker. A data outage defers; a genuinely negative test rejects. A full shadow slot queues a candidate without replacing an immature incumbent. In-flight execution is idempotent by cycle/candidate fingerprint and uses a market lock. US/India never share return values or implicit parameter fits. Market closure does not advance a session. Training and evaluation boundaries cannot slide after results are inspected. Provider/auth/quota failures are surfaced without repeated inference. Trading brakes do not suppress research generation or outcome evaluation.

## 7. Files that may be touched later

- app/api/agents/learner/route.ts: deterministic seed/combination cycle before the optional model tool loop; explicit cycle result.
- lib/strategy-replay/autonomous-template-discovery.ts: reusable preparation, registration-before-screening and source provenance.
- lib/strategy-replay/template-compiler.ts and rule-spec.ts: versioned supported point-in-time feature/combination nodes.
- Existing template-backtest, autonomous-template-selector, trial-registry and dataset code: matched parent/baseline comparisons, fold diagnostics and failure taxonomy.
- Existing ResearchAgent shadow collector: exact same point-in-time compiler inputs; no second scoring calculation.
- Existing strategy API, Learning, Agents, Upgrade Path and symbol-detail consumers: one coherent status/diagnostic view.
- Targeted migration only if ledger-capability review demonstrates a missing invariant.
- docs/arch/03-agents.md, 04-database-schema.md if needed, 09-learning-loop.md, public/agent-diagrams/system-map.json, implementation results and work log.

## 8. Risks / decisions needed

Combination search increases false discoveries; the trial ledger, untouched evaluation and fixed budgets are part of the algorithm. Free cached history is incomplete and cannot prove universal historical applicability. All-dimension replay begins with availability audits; it cannot pretend old point-in-time observations exist. The proposed cached CPU budget and candidate counts must be measured before increasing them. No money or compute upgrade is authorized.

Primary research: Bailey et al., The Probability of Backtest Overfitting, https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf ; Novy-Marx, Backtesting Strategies Based on Multiple Signals, https://www.nber.org/papers/w21329 . These support multiplicity/selection controls, not profitable strategy claims.

## 9. Acceptance criteria

1. A scheduled cycle with no LLM proposal still attempts eligible existing seeds and records its exact outcome.
2. Every screened seed, combination and revision has immutable provenance and is counted before screening.
3. Unsupported dimensions and missing historical timestamps remain visible and cannot enter an eligible replay.
4. Parent/baseline/candidate use identical opportunity sets and realistic, identical cost conventions.
5. Tests cover no future inputs, horizon purging, market/exposure isolation, trial deduplication, negative evidence, empty universes, slot contention and resumable budgets.
6. A failure-driven revision cannot reuse its inspected final evaluation period as fresh validation.
7. Natural production evidence shows a recorded cycle and at least a real attempted seed or a verifiable blocker; test fixtures do not substitute.
8. Existing paper selection and live execution gates retain their documented authority.

## 10. Approval gate

This expands the shipped price-only optional-proposal workflow to automatic existing-strategy seeds, combinations, dimension observations and failure-driven research. Owner approved implementation on 2026-11-03 with "finish all pending work". Runtime completion and natural evidence gates must be recorded independently.
