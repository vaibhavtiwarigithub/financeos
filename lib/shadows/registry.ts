export type ShadowLifecycle =
  | "collecting"
  | "ready_for_review"
  | "blocked"
  | "armed"
  | "paper_active"
  | "idle"
  | "off"
  | "not_applicable";

export type BenefitVerdict =
  | "benefited"
  | "promising"
  | "mixed"
  | "not_beneficial"
  | "insufficient"
  | "operational_only";

export type CallAccountingMode =
  | "tracked"
  | "zero_incremental"
  | "unmetered"
  | "not_applicable";

export type MainlineImplementationScope =
  | "inert_scaffold"
  | "measure_only"
  | "paper_capable"
  | "live_capable";

export interface MainlineRelease {
  /** First commit that put the program's runnable or owner-visible implementation on main. */
  commit: string;
  enteredAt: string;
  implementationScope: MainlineImplementationScope;
  /** Why code was merged even when its scoring/trading influence remained disabled. */
  reason: string;
}

export interface ShadowProgramDefinition {
  id: string;
  name: string;
  category: "Data" | "Scoring" | "Trading" | "Risk" | "Portfolio" | "Learning";
  markets: readonly ("us" | "india")[];
  purpose: string;
  productBenefit: string;
  traderBenefit: string;
  evidenceSource: string;
  currentInfluence: string;
  maximumInfluence: string;
  activationGate: string;
  safetyBoundary: string;
  cronJobs: readonly string[];
  callAccounting: CallAccountingMode;
  owner: string;
  architectureRef: string;
  mainline: MainlineRelease;
}

export const SHADOW_PROGRAMS: readonly ShadowProgramDefinition[] = [
  {
    id: "dimension-diagnostics",
    name: "Dimension and agent diagnostics",
    category: "Learning",
    markets: ["us", "india"],
    purpose: "Separates evidence degradation, descriptive factor behavior, agent contribution and execution confounders before any repair is proposed.",
    productBenefit: "Turns a bad result into an auditable diagnosis instead of an automatic score rewrite or an untestable explanation.",
    traderBenefit: "Shows whether a weakness is data quality, a thin sample, a market-local signal question, or an execution constraint.",
    evidenceSource: "decision_observations x observation_labels, recorded in dimension_diagnostic_runs and dimension_diagnostic_findings",
    currentInfluence: "P0 read-only diagnostics. It cannot change agents, scores, thresholds, strategy versions, paper/live positions, exits or orders.",
    maximumInfluence: "A qualified finding may create a separately governed candidate for existing replay and shadow validation; no automatic activation.",
    activationGate: "P0 is permanently measure-only. Any candidate must meet point-in-time, predeclared trial-family, sealed replay, forward-shadow and owner-promotion gates.",
    safetyBoundary: "No provider calls. Append-only diagnostic rows only; collaboration remains unattributable without a paired shadow counterfactual.",
    cronJobs: ["kairos-dimension-diagnostics-us", "kairos-dimension-diagnostics-india"],
    callAccounting: "zero_incremental",
    owner: "Learning / Evidence",
    architectureRef: "features/dimension-diagnostics/FEATURE_ARCHITECTURE.md",
    mainline: { commit: "0a48e791", enteredAt: "2026-08-06", implementationScope: "measure_only", reason: "Add governed, append-only diagnostics so weak results are attributed before any score or strategy repair is proposed." },
  },
  {
    // Added 2026-08-06. This program exists because a diagnosis written that
    // same day produced a confident causal story about universe composition and
    // was refuted by the next query: its whole matured-label set turned out to
    // span one fortnight, and the cohort it blamed had entry_eligible=false on
    // every row. `n` looked large because observations repeat across correlated
    // symbols and overlapping dates; the effective sample is the DATE count.
    // Nothing here changes a decision — it measures whether any other program's
    // evidence is yet capable of supporting a conclusion.
    id: "decision-label-coverage",
    name: "Decision-label coverage",
    category: "Learning",
    markets: ["us", "india"],
    purpose: "Measure whether matured decision labels span enough independent dates and symbols to support any claim about scoring, universe or exits.",
    productBenefit: "Stops Kairos drawing confident conclusions — and shipping changes — from a single market fortnight.",
    traderBenefit: "Prevents a rule change justified by one regime from being applied to every future regime.",
    evidenceSource: "decision_observations x observation_labels (distinct dates, symbols and horizons)",
    currentInfluence: "None. Read-only measurement of other programs' evidence sufficiency.",
    maximumInfluence: "Advisory gate: other programs cite its date coverage before claiming a result. It never scores, sizes or trades.",
    activationGate: "Not applicable — this program is permanently measure-only and is never promoted to a decision path.",
    safetyBoundary: "Reads two evidence tables. No score, eligibility, sizing, entry, exit, promotion or broker consumer, now or later.",
    cronJobs: ["kairos-label-maturation"],
    callAccounting: "zero_incremental",
    owner: "Evidence / Learning",
    architectureRef: "features/portfolio-underperformance/DIAGNOSIS.md",
    mainline: { commit: "1704c18a", enteredAt: "2026-08-06", implementationScope: "measure_only", reason: "Expose independent-date and symbol coverage so thin correlated samples cannot masquerade as learning evidence." },
  },
  {
    // Added 2026-08-06. The owner asked to shorten the exit target; measuring it
    // first showed that for US it is INERT (targets of 19.2%, 10% and 6% give
    // the identical -1.58% mean, because 22 of 28 positions never reach +6%),
    // while for India a 6% target with a 5% stop lifts the mean from +0.28% to
    // +0.81% with an interior optimum. Neither is actionable at 7 and 2 distinct
    // dates. This program exists so the re-test is scheduled rather than
    // remembered: it reports progress toward the date floor and says when the
    // question becomes decidable.
    id: "exit-geometry",
    name: "Exit-geometry shadow",
    category: "Trading",
    markets: ["us", "india"],
    purpose: "Measure what alternative stop/target geometries would have produced, before any exit rule is changed.",
    productBenefit: "Turns 'shorten the target' from a guess into a decidable question with a stated evidence threshold.",
    traderBenefit: "Prevents an exit change fitted to a single fortnight from being applied to every future regime.",
    evidenceSource: "observation_labels (MFE/MAE/fwd at the traded horizon) via GET /api/agents/exit-geometry-shadow",
    currentInfluence: "None. Read-only counterfactual; it writes nothing and no exit reads it.",
    maximumInfluence: "Advisory input to an owner-approved exit-geometry proposal. It never changes a stop, target or time stop itself.",
    activationGate: "Twenty distinct decision dates at the 10-day horizon per market, an ambiguous share at or below 20%, and a separate owner-approved architecture round for any change.",
    safetyBoundary: "Reads matured labels only. No score, eligibility, sizing, entry, exit, promotion or broker consumer, now or later.",
    cronJobs: ["kairos-label-maturation"],
    callAccounting: "zero_incremental",
    owner: "Trading / Evidence",
    architectureRef: "features/portfolio-underperformance/DIAGNOSIS.md",
    mainline: { commit: "b2834f48", enteredAt: "2026-08-06", implementationScope: "measure_only", reason: "Measure alternative stop/target geometry from matured labels before changing any exit behavior." },
  },
  {
    id: "evidence-router",
    name: "Evidence Router parity",
    category: "Data",
    markets: ["us", "india"],
    purpose: "Prove that configurable provider routing preserves or improves the evidence used by the current scorer.",
    productBenefit: "Lets Kairos change providers and quotas without rewriting every agent or silently changing scores.",
    traderBenefit: "Reduces data-source outages and prevents a provider substitution from creating a false buy.",
    evidenceSource: "evidence_policy_evaluations + provider_call_ledger",
    currentInfluence: "Shadow resolution and cache population only; router_enabled is false.",
    maximumInfluence: "May become the canonical evidence resolver after separate per-market activation.",
    activationGate: "Fresh safety and quality pass, ten validated market sessions, zero unreviewed eligibility flips, owner activation.",
    safetyBoundary: "No score or trading consumer while router_enabled=false; cohort comparison is cache-only.",
    cronJobs: [
      "kairos-evidence-shadow-us", "kairos-evidence-shadow-india",
      "kairos-evidence-cohort-us", "kairos-evidence-cohort-india",
    ],
    callAccounting: "tracked",
    owner: "Evidence / Research",
    architectureRef: "features/router-cutover/FEATURE_ARCHITECTURE.md",
    mainline: { commit: "fc9bace1", enteredAt: "2026-07-13", implementationScope: "measure_only", reason: "Collect dual-run provider parity evidence before allowing the configurable router to replace canonical research inputs." },
  },
  {
    id: "degradation-guard",
    name: "Evidence degradation guard",
    category: "Risk",
    markets: ["us", "india"],
    purpose: "Measure when missing or degraded evidence would make a new long eligible only because weights were renormalized.",
    productBenefit: "Makes provider degradation visible before it can change eligibility.",
    traderBenefit: "When separately enabled, it can only abstain from a questionable new long; it can never create an entry or suppress an exit.",
    evidenceSource: "evidence_degradation_events",
    currentInfluence: "Measure-only counterfactual events.",
    maximumInfluence: "Strictly subtractive long-to-neutral guard.",
    activationGate: "Stable would-abstain rate, reviewed false-positive sample, clean market-local baseline, owner mode change.",
    safetyBoundary: "Short/exit directions pass untouched; invalid config defaults to measure_only.",
    cronJobs: ["kairos-evidence-shadow-us", "kairos-evidence-shadow-india"],
    callAccounting: "zero_incremental",
    owner: "Research safety",
    architectureRef: "features/router-cutover/FEATURE_ARCHITECTURE.md",
    mainline: { commit: "eb5bca43", enteredAt: "2026-07-16", implementationScope: "measure_only", reason: "Record whether missing evidence would create false eligibility through weight renormalization before enabling a subtractive guard." },
  },
  {
    id: "india-news-evidence",
    name: "India news and event evidence",
    category: "Data",
    markets: ["india"],
    purpose: "Measure reliable symbol-level India headline coverage and official corporate announcements after the zero-output GDELT scoring path was retired.",
    productBenefit: "Can restore an India-specific news evidence dimension only if the replacement proves freshness, relevance and stable coverage.",
    traderBenefit: "Surfaces company events and headline context without pretending that headline volume or an unavailable feed predicts direction.",
    evidenceSource: "evidence_cache_v2 + provider_call_ledger (india-news-shadow run IDs)",
    currentInfluence: "Coverage/provenance shadow only; India sentiment is structurally excluded from active scoring.",
    maximumInfluence: "A separately validated deterministic sentiment feature may enter challenger validation; never direct activation.",
    activationGate: "At least 20 distinct collection dates, stable relevant-headline coverage, source-health review, PIT historical evaluation and separate owner approval.",
    safetyBoundary: "No scorer, signal, paper/live trade, position monitor, learner mutation or broker path reads the shadow intents.",
    cronJobs: ["kairos-india-news-shadow"],
    callAccounting: "tracked",
    owner: "Evidence / India Research",
    architectureRef: "features/pipeline-data-and-timing/FEATURE_ARCHITECTURE.md",
    mainline: { commit: "dc1e2960", enteredAt: "2026-07-31", implementationScope: "measure_only", reason: "Begin bounded India-specific news and corporate-event collection without borrowing US sentiment semantics or changing scores." },
  },
  {
    id: "setup-experts",
    name: "Setup expert comparison",
    category: "Scoring",
    markets: ["us", "india"],
    purpose: "Compare asset/setup-specific score formulas with the v1 actionable score on the same opportunities.",
    productBenefit: "Shows whether one universal score should eventually be replaced by setup-aware experts.",
    traderBenefit: "Could stop defensive ETFs, momentum equities, and India equities from being judged by inappropriate evidence.",
    evidenceSource: "shadow_decisions",
    currentInfluence: "Writes would-enter decisions only; v1 remains actionable.",
    maximumInfluence: "A validated setup expert may progress through shadow, paper and owner-reviewed live stages.",
    activationGate: "Point-in-time labels, walk-forward net-of-cost validation, stable calibration and an approved promotion lifecycle.",
    safetyBoundary: "No cash, positions, proposals or orders are created from shadow_decisions.",
    cronJobs: [],
    callAccounting: "zero_incremental",
    owner: "Scoring / Learner",
    architectureRef: "features/scoring-methodology/FEATURE_ARCHITECTURE.md",
    mainline: { commit: "6dca1f3c", enteredAt: "2026-07-10", implementationScope: "measure_only", reason: "Compare setup-specific scoring experts against the champion on identical evidence while keeping them outside eligibility and trading." },
  },
  {
    id: "technical-calibration",
    name: "Technical edge calibration",
    category: "Scoring",
    markets: ["us", "india"],
    purpose: "Measure every registered price/volume technical edge, including the existing composite, MACD/ATR, signed ADX, momentum, breakout and relative-strength challengers.",
    productBenefit: "Prevents indicator changes from being made because they sound plausible rather than because they improve ranking.",
    traderBenefit: "May identify a more robust entry/exit timing feature by market without hand-tuning every sector.",
    evidenceSource: "edge_signals + edge_ic_history + edge_readiness_status",
    currentInfluence: "Calibration remains measure-only; fresh US relative-strength rows may admit up to four candidates, then normal scoring and portfolio gates decide eligibility.",
    maximumInfluence: "A validated feature may request shadow review; it still cannot self-promote.",
    activationGate: "Six stable weekly windows plus four point-in-time, cost/FDR-adjusted validation windows.",
    safetyBoundary: "Edge values cannot change score, size, promotion, exits, or orders; candidate admission is bounded, US-only, and provenance-recorded.",
    cronJobs: [
      "kairos-edge-scout-us", "kairos-edge-scout-india",
      "kairos-edge-ic-us", "kairos-edge-ic-india", "kairos-edge-readiness",
    ],
    callAccounting: "unmetered",
    owner: "EdgeScout / EdgeIC",
    architectureRef: "features/technical-factor-calibration/FEATURE_ARCHITECTURE.md",
    mainline: { commit: "a249d50e", enteredAt: "2026-07-21", implementationScope: "measure_only", reason: "Measure parameter stability and cost/FDR robustness before any technical feature may enter a scoring challenger." },
  },
  {
    id: "pit-fundamental-qualification",
    name: "Point-in-time fundamental qualification",
    category: "Data",
    markets: ["us", "india"],
    purpose: "Qualify dated, restatement-safe reported facts before gross profitability, leverage, free-cash-flow yield, or growth-acceleration can be measured.",
    productBenefit: "Prevents current provider snapshots from being misrepresented as historical inputs and keeps a single fundamental provenance ledger.",
    traderBenefit: "Makes a missing filing date, stale source, or incompatible instrument explicitly unavailable instead of a false neutral score.",
    evidenceSource: "fundamental_facts append-only vintages",
    currentInfluence: "Capture-on-fetch provenance only; candidate fundamental features are not scored or shadowed.",
    maximumInfluence: "Qualified features may enter a separate market-local replay and non-executing challenger shadow.",
    activationGate: "Per-market source, units, known-at, restatement, taxonomy and freshness contracts; then sealed replay and forward shadow evidence.",
    safetyBoundary: "The fundamental ledger has no score, eligibility, sizing, paper, live, exit, or broker consumer for candidate features.",
    cronJobs: [],
    callAccounting: "zero_incremental",
    owner: "Research data / PIT",
    architectureRef: "features/feature-pack-validation/FEATURE_ARCHITECTURE.md",
    mainline: { commit: "e2cd9b73", enteredAt: "2026-07-10", implementationScope: "measure_only", reason: "Archive point-in-time fundamental vintages so future qualification cannot use revised or future-known facts." },
  },
  {
    id: "specialist-feature-packs",
    name: "Specialist instrument packs",
    category: "Scoring",
    markets: ["us", "india"],
    purpose: "Define separate data contracts for banks, REITs and leveraged ETFs rather than applying generic company fundamentals to incompatible instruments.",
    productBenefit: "Keeps instrument-specific analysis extensible without silently widening the universal five-dimension score.",
    traderBenefit: "Avoids using EPS/P-E for REITs, generic FCF for banks, or company fundamentals for leveraged ETFs.",
    evidenceSource: "instrument_registry + future qualified specialist fact contracts",
    currentInfluence: "Generic price/liquidity evidence only; no specialist scorer, shadow, candidate or trade behavior exists.",
    maximumInfluence: "Each pack can enter its own market-local measure-only trial after data and risk contracts pass.",
    activationGate: "Qualified raw data per instrument family, immutable feature definitions, market-local replay, forward shadow and separate owner approval.",
    safetyBoundary: "No specialist pack may inherit company features by default or change a score, paper/live trade, exit, size, or broker order.",
    cronJobs: [],
    callAccounting: "not_applicable",
    owner: "Instrument governance",
    architectureRef: "features/feature-pack-validation/FEATURE_ARCHITECTURE.md",
    mainline: { commit: "4ea20075", enteredAt: "2026-08-02", implementationScope: "inert_scaffold", reason: "Publish an instrument-aware feature applicability catalog before choosing or funding any specialist data contract." },
  },
  {
    id: "capital-rotation",
    name: "Capital rotation",
    category: "Trading",
    markets: ["us", "india"],
    purpose: "Evaluate replacing the weakest sellable holding when a materially better candidate appears and the book is full or cash-constrained.",
    productBenefit: "Makes opportunity cost explicit instead of treating a full book as a permanent no-op.",
    traderBenefit: "Can recycle capital into stronger candidates while respecting holding period, turnover, cost, tax and anti-thrash gates.",
    evidenceSource: "rotation_config + rotation_events + paper_trades",
    // State as of 2026-08-25, verified against rotation_config AND paper_trades.
    //
    // This line has now been wrong twice, in opposite directions. It read "Paper
    // execution is enabled" while every flag was false; it was then corrected to
    // say rotation "has never moved capital", which is ALSO false — rotation
    // executed two swaps (2026-07-24 PLTR→CB, 2026-07-27 ONGC.NS→TCS.NS) and
    // four sell lots carry exit_reason='capital_rotation'. The mistake was
    // reading NULL rotation_events.paper_trade_ids as proof of non-execution
    // while status='paper_executed' sat in the same rows. Confirm against the
    // table that records the EFFECT (paper_trades), not the one that records
    // intent. Keep this pinned to observed state, never to intent.
    currentInfluence: "Shadow only. rotation_paper_execute_enabled=false and rotation_allow_score_only_paper=false on both book_type='paper' rows; both book_type='live' rows false; rotation_live_proposals_enabled=false everywhere. It HAS executed before: two swaps in July 2026 (4 sell lots, exit_reason='capital_rotation'), after which the paper flags were set false on 2026-08-11 for reasons not yet established — see docs/audits/2026-08-25-rotation-unreachable-trace.md before re-enabling.",
    maximumInfluence: "Two-leg owner-reviewed live rotation proposal after paper evidence and broker reconciliation proof.",
    activationGate: "Positive net paper outcome after costs, stable churn/turnover, tax/lot correctness, live two-leg approval and reconciliation sign-off.",
    safetyBoundary: "PositionMonitor exits have precedence; live rotation proposals remain disabled.",
    cronJobs: [],
    callAccounting: "zero_incremental",
    owner: "PaperTrader / TraderAgent",
    architectureRef: "features/capital-rotation/FEATURE_ARCHITECTURE.md",
    mainline: { commit: "ac7ffda0", enteredAt: "2026-07-13", implementationScope: "paper_capable", reason: "Measure opportunity-cost replacements in fully invested paper books; execution remains separately gated after unsafe early P1 behavior." },
  },
  {
    id: "earnings-risk",
    name: "Earnings event risk",
    category: "Risk",
    markets: ["us", "india"],
    purpose: "Measure whether a planned swing crosses earnings and, for US names, whether the analytical stop sits inside the option-implied move.",
    productBenefit: "Adds an auditable event-risk layer without inventing a directional options signal.",
    traderBenefit: "Can eventually avoid stops that are statistically inside the market-priced earnings move or size down event exposure.",
    evidenceSource: "earnings_risk_observations",
    currentInfluence: "Shadow annotation only; behavior_changed is database-pinned false.",
    maximumInfluence: "Owner-approved entry block or deterministic size reduction; never an alpha score.",
    activationGate: "At least 60 otherwise-eligible US entries, 20 distinct events, usable quote coverage, calibration review and a separate owner decision.",
    safetyBoundary: "No score, fill, rotation, stop, target, exit or order reads the counterfactual verdict.",
    cronJobs: ["kairos-earnings-pit-capture"],
    callAccounting: "unmetered",
    owner: "Risk / Earnings",
    architectureRef: "features/earnings-aware-risk/FEATURE_ARCHITECTURE.md",
    mainline: { commit: "65c1c5be", enteredAt: "2026-07-29", implementationScope: "measure_only", reason: "Capture point-in-time earnings proximity and move-risk evidence before allowing event risk to change entries or sizing." },
  },
  {
    id: "exogenous-risk",
    name: "India macro and global spillover evidence",
    category: "Risk",
    markets: ["us", "india"],
    purpose: "Create a timestamped, source-backed record of India domestic macro facts and global spillover facts before any regime interpretation is considered.",
    productBenefit: "Makes missing India macro coverage explicit and prevents an untraceable or stale macro input from being mistaken for neutral.",
    traderBenefit: "Can eventually support a separately validated, market-local risk guard without mixing USD and INR books or inventing a directional signal.",
    evidenceSource: "exogenous_observations + market_regime_runs",
    currentInfluence: "Schema foundation only; no source adapter, scorer, signal, paper/live trade, exit, sizing, or broker reader exists.",
    maximumInfluence: "At most a separately approved, deterministic, subtractive paper risk guard after point-in-time validation.",
    activationGate: "Stable official timestamped source adapters, point-in-time coverage, market-local validation, evidence review, and separate owner approval.",
    safetyBoundary: "An empty or stale observation is unavailable, never neutral. This program has no money-path consumer.",
    cronJobs: [],
    callAccounting: "not_applicable",
    owner: "Macro / Risk",
    architectureRef: "features/exogenous-risk-evidence/FEATURE_ARCHITECTURE.md",
    mainline: { commit: "57c63cf3", enteredAt: "2026-08-01", implementationScope: "inert_scaffold", reason: "Create governed append-only source and regime ledgers before approving official adapters or score consumers." },
  },
  {
    id: "international-allocation",
    name: "International allocation",
    category: "Portfolio",
    markets: ["us"],
    purpose: "Observe whether a US book should reserve a broad non-US equity sleeve rather than relying entirely on domestic names.",
    productBenefit: "Creates an explicit, reviewable diversification policy instead of accidental country exposure.",
    traderBenefit: "Could reduce US concentration and regime dependence through a bounded broad-core allocation.",
    evidenceSource: "international_allocation_policies + international_allocation_assessments",
    currentInfluence: "Weekly action=none observation; target and band are unset.",
    maximumInfluence: "Owner-approved paper allocation before any live rebalance.",
    activationGate: "Approved target/deadband, broader family comparison, cost/tax review and paper tracking.",
    safetyBoundary: "Reads persisted US/USD positions only; allocation_enabled remains false.",
    cronJobs: ["kairos-international-allocation-shadow"],
    callAccounting: "zero_incremental",
    owner: "Portfolio construction",
    architectureRef: "features/international-equity-allocation/FEATURE_ARCHITECTURE.md",
    mainline: { commit: "89ca679f", enteredAt: "2026-07-27", implementationScope: "measure_only", reason: "Make international exposure and target/deadband proposals observable before any allocation can alter a portfolio." },
  },
  {
    id: "autonomous-live",
    name: "Autonomous live execution",
    category: "Trading",
    markets: ["us", "india"],
    purpose: "Dry-run the deterministic nine-gate execution kernel against qualifying signals before any autonomous broker submission is allowed.",
    productBenefit: "Proves the execution envelope and audit trail independently from broker money movement.",
    traderBenefit: "Would allow bounded hands-off live execution only after every risk, freshness, budget and account gate is proven.",
    evidenceSource: "trade_proposals where execution_mode=autonomous_shadow",
    currentInfluence: "Off; idle crons removed and live_auto_enabled is false.",
    maximumInfluence: "Owner-enabled autonomous execution inside a fixed deterministic envelope.",
    activationGate: "New approved evidence campaign, sufficient queued-vs-blocked samples, broker canaries, kill-switch drills and explicit owner enablement.",
    safetyBoundary: "No broker call in shadow; live_auto_enabled and per-market mode remain fail-closed.",
    cronJobs: ["kairos-shadow-us", "kairos-shadow-india"],
    callAccounting: "unmetered",
    owner: "Execution kernel",
    architectureRef: "features/live-auto-trading/FEATURE_ARCHITECTURE.md",
    mainline: { commit: "e45ca642", enteredAt: "2026-07-10", implementationScope: "live_capable", reason: "Land the fail-closed per-market autonomous execution path behind disabled policy, evidence, broker-canary, and kill-switch gates." },
  },
  {
    id: "challenger-validation",
    name: "Strategy challenger validation",
    category: "Learning",
    markets: ["us", "india"],
    purpose: "Validate learner-proposed challengers and route at most one passing version per market into non-executing shadow evidence.",
    productBenefit: "Turns strategy improvement into a controlled lifecycle rather than direct weight mutation.",
    traderBenefit: "Prevents an attractive backtest or LLM hypothesis from becoming tradable without reproducible out-of-sample proof.",
    evidenceSource: "strategy_validation_automation + strategy_versions + validation_experiments",
    currentInfluence: "Armed; no active shadow_paper challenger.",
    maximumInfluence: "May route a passed challenger to shadow_paper; champion/live promotion stays separate.",
    activationGate: "A challenger must exist and pass the deterministic validation engine; only one shadow slot per market.",
    safetyBoundary: "Cannot promote a champion, fill paper positions, create live proposals or submit orders.",
    cronJobs: ["kairos-validation-sweep"],
    callAccounting: "zero_incremental",
    owner: "Learner / Validation",
    architectureRef: "features/automated-strategy-validation/FEATURE_ARCHITECTURE.md",
    mainline: { commit: "0004eeb8", enteredAt: "2026-07-12", implementationScope: "measure_only", reason: "Automate deterministic challenger validation and bounded shadow-slot routing without granting promotion or money authority." },
  },
  {
    id: "downside-hedge",
    name: "Downside hedge",
    category: "Risk",
    markets: ["us"],
    purpose: "Evaluate a small, time-bounded inverse-ETF hedge when deterministic portfolio and macro stress gates agree.",
    productBenefit: "Provides a governed alternative to ad hoc discretionary hedging.",
    traderBenefit: "Could reduce severe drawdown while capping hedge size, duration and churn.",
    evidenceSource: "downside_hedge_config + downside_hedge_events",
    currentInfluence: "Off; no shadow or paper events.",
    maximumInfluence: "US paper hedge only until a separate live architecture is approved.",
    activationGate: "Owner enables shadow collection, then paper only after stress precision and hedge drag are reviewed.",
    safetyBoundary: "Feature and paper execution flags are false; no live path exists.",
    cronJobs: ["kairos-downside-hedge-us"],
    callAccounting: "zero_incremental",
    owner: "Portfolio risk",
    architectureRef: "features/downside-hedging/FEATURE_ARCHITECTURE.md",
    mainline: { commit: "38a18f0a", enteredAt: "2026-07-15", implementationScope: "paper_capable", reason: "Ship a governed hedge evaluator and paper-only path behind independent disabled flags so drag and precision can be measured first." },
  },
] as const;

export const SHADOW_PROGRAM_IDS = SHADOW_PROGRAMS.map((program) => program.id);
