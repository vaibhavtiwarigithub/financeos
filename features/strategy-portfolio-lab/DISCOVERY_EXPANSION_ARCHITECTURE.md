# Existing strategies, combinations, and autonomous discovery

Date: 2026-11-03
Status: architecture ready for review; expansion is not implemented.
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

Existing weekly cycle -> capability audit -> reference seeds -> bounded combinations -> optional new LLM hypothesis -> immutable trial registration -> cached historical screen -> failure diagnostics or eligible queue -> existing forward slot -> natural research observations and labels -> deterministic tournament -> governed paper preference or retirement. Every cycle stores an explicit evaluated, deferred, abstained, empty-catalog, disabled, capacity-full, or error outcome. An absent producer run is different from an empty result.

## 5. UI / API / data / interaction model

Learning owns a single strategy-discovery funnel: next/last producer cycle, counts by stage, exact pending reason, and candidate detail. Detail shows source formulas/strategies, versions, combination, trial count, data coverage, chronological folds, net benchmark/baseline/parent deltas, predeclared slices, failures, revisions, untouched-forward maturity, and current authority. Agents owns execution/producer status; Upgrade Path summarizes readiness; Symbol Research displays applicable candidate matches with evidence state. Paper Portfolio explains a selected strategy's contribution to ranking. Reuse existing routes and panels.

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

This expands the shipped price-only optional-proposal workflow to automatic existing-strategy seeds, combinations, dimension observations and failure-driven research. Architecture is ready for review. I will not write code until you approve this architecture.
