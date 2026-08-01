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
}

export const SHADOW_PROGRAMS: readonly ShadowProgramDefinition[] = [
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
  },
  {
    id: "technical-calibration",
    name: "Technical parameter calibration",
    category: "Scoring",
    markets: ["us", "india"],
    purpose: "Measure the existing technical composite beside MACD/ATR and signed ADX challengers.",
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
    currentInfluence: "Paper execution is enabled; live proposals are disabled.",
    maximumInfluence: "Two-leg owner-reviewed live rotation proposal after paper evidence and broker reconciliation proof.",
    activationGate: "Positive net paper outcome after costs, stable churn/turnover, tax/lot correctness, live two-leg approval and reconciliation sign-off.",
    safetyBoundary: "PositionMonitor exits have precedence; live rotation proposals remain disabled.",
    cronJobs: [],
    callAccounting: "zero_incremental",
    owner: "PaperTrader / TraderAgent",
    architectureRef: "features/capital-rotation/FEATURE_ARCHITECTURE.md",
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
  },
] as const;

export const SHADOW_PROGRAM_IDS = SHADOW_PROGRAMS.map((program) => program.id);
