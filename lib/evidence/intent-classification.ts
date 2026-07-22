// Canonical Evidence Router — intent classification + scorer field ownership
// (router-cutover feature, §3). CODE-OWNED. A DB row can never reclassify an
// intent or relax a field contract.
//
// This module is the single answer to two questions a cutover must be able to
// answer BEFORE it happens:
//   1. What can this intent change? (score / eligibility / narrative / nothing)
//   2. For each scorer field: which intent must serve it, what is the minimum
//      field contract, which quality/freshness states are acceptable, and where
//      does the legacy (pre-router) path get it today?
//
// Pure types + constants + pure functions. No DB, no network, no LLM, no side
// effects. Importing this wires NOTHING into scoring — it is a description of
// the contract the degradation guard (§6) and the dual-run evaluation (§4/§5)
// both read, so the two can never drift into separate truths.
//
// Per §3 explicitly:
//   - `analyst.consensus` is NARRATIVE-ONLY in the US and UNSUPPORTED in India.
//     It is therefore never a scoring-cutover blocker in either market, and
//     India parity for it is not required.

import type {
  EvidenceIntent,
  EvidenceQuality,
  FieldUnit,
  Market,
  MetricBasis,
} from "@/lib/evidence/contracts";
import { INTENT_CATALOG } from "@/lib/evidence/contracts";
import type { ScoreDimension } from "@/lib/scoring/weighted-score";

// ── §3 intent classes ────────────────────────────────────────────────────────

export type IntentClass =
  | "score_affecting"       // canonical fields consumed by a deterministic dimension
  | "eligibility_affecting" // prices/events used by filters, freshness, ranks, gates
  | "narrative_only"        // display/context; cannot change score or eligibility
  | "unsupported";          // no valid market capability

// Precedence when an intent could be read as more than one class. A dimension
// input is classified `score_affecting` even though it ALSO feeds gates — the
// stronger class wins, because the cutover controls keyed off this must apply
// the stricter treatment.
const CLASS_RANK: Record<IntentClass, number> = {
  unsupported: 0,
  narrative_only: 1,
  eligibility_affecting: 2,
  score_affecting: 3,
};

export function strictestClass(a: IntentClass, b: IntentClass): IntentClass {
  return CLASS_RANK[a] >= CLASS_RANK[b] ? a : b;
}

export interface IntentClassification {
  intent: EvidenceIntent;
  /** Per-market class. A market absent from this map is `unsupported`. */
  byMarket: Partial<Record<Market, IntentClass>>;
  /** Also used by non-scoring gates even when the primary class is scoring. */
  alsoGates: boolean;
  note: string;
}

export const INTENT_CLASSIFICATION: Record<EvidenceIntent, IntentClassification> = {
  "price.quote": {
    intent: "price.quote",
    byMarket: { us: "eligibility_affecting", india: "eligibility_affecting" },
    alsoGates: true,
    note: "Last price drives sizing, stop distance, and price-basis gates. Never a scoring dimension.",
  },
  "price.daily_bars": {
    intent: "price.daily_bars",
    byMarket: { us: "score_affecting", india: "score_affecting" },
    alsoGates: true,
    note: "RSI/EMA are computed locally from these bars → technical dimension. Also the price basis for ranks.",
  },
  "fundamentals.reported": {
    intent: "fundamentals.reported",
    byMarket: { us: "score_affecting", india: "score_affecting" },
    alsoGates: false,
    note: "Feeds the fundamental dimension. Structurally not applicable to ETFs.",
  },
  "fundamentals.valuation": {
    intent: "fundamentals.valuation",
    byMarket: { us: "score_affecting", india: "score_affecting" },
    alsoGates: false,
    note: "Valuation multiples folded into the fundamental dimension. Legacy path merges them into the same overview map.",
  },
  "analyst.consensus": {
    intent: "analyst.consensus",
    // §3: US analyst data is NARRATIVE ONLY — it must never block a scoring
    // cutover. India has no analyst provider, and parity is NOT required there.
    byMarket: { us: "narrative_only", india: "unsupported" },
    alsoGates: false,
    note: "US: grounding line in the thesis prompt only — no score, no gate. India: no capability; abstains without reducing US coverage.",
  },
  "sentiment.news": {
    intent: "sentiment.news",
    byMarket: { us: "score_affecting", india: "score_affecting" },
    alsoGates: false,
    note: "Sentiment dimension. India (GDELT) is genuinely sparse — expected absence, not starvation.",
  },
  "insider.transactions": {
    intent: "insider.transactions",
    byMarket: { us: "score_affecting", india: "score_affecting" },
    alsoGates: false,
    note: "Insider dimension. Sparse by nature (open-market Form 4 / NSE PIT). Not applicable to ETFs or US ADRs.",
  },
  "events.earnings": {
    intent: "events.earnings",
    byMarket: { us: "eligibility_affecting", india: "eligibility_affecting" },
    alsoGates: true,
    note: "Earnings proximity gates entries; point-in-time correctness matters. No stale ceiling.",
  },
  "events.corporate_actions": {
    intent: "events.corporate_actions",
    byMarket: { us: "eligibility_affecting", india: "eligibility_affecting" },
    alsoGates: true,
    note: "Splits/dividends decide whether a price series is comparable — an adjustment error is an eligibility error.",
  },
  "macro.regime_inputs": {
    intent: "macro.regime_inputs",
    // India has NO macro regime: MacroSentinel is US-only FRED data,
    // macro_regime table has no market column, and fetchMacroScore explicitly
    // returns available:false for India. Marking india "unsupported" here
    // matches the pipeline reality and stops the shadow resolver from
    // reporting 0% India macro coverage as a starvation alert.
    byMarket: { us: "score_affecting" },
    alsoGates: false,
    note: "Macro dimension, market-wide (no symbol). US-only — India has no MacroSentinel.",
  },
};

/** Per-market class for an intent. Unknown/unsupported market → `unsupported`. */
export function classifyIntent(intent: EvidenceIntent, market: Market): IntentClass {
  const spec = INTENT_CATALOG[intent];
  // The catalog's market list is the capability floor: an intent not offered in
  // a market is unsupported regardless of what the classification table says.
  if (!spec || !spec.markets.includes(market)) return "unsupported";
  return INTENT_CLASSIFICATION[intent]?.byMarket[market] ?? "unsupported";
}

/** True when activating this intent in this market could move a score. */
export function isScoreAffecting(intent: EvidenceIntent, market: Market): boolean {
  return classifyIntent(intent, market) === "score_affecting";
}

/**
 * Intents that must clear the full activation gate for a market. Narrative-only
 * and unsupported intents are deliberately excluded — per §3 they cannot block
 * a scoring cutover.
 */
export function gatedIntents(market: Market): EvidenceIntent[] {
  return (Object.keys(INTENT_CLASSIFICATION) as EvidenceIntent[]).filter((i) => {
    const c = classifyIntent(i, market);
    return c === "score_affecting" || c === "eligibility_affecting";
  });
}

// ── Scorer field ownership matrix (§3, §8.1) ─────────────────────────────────

/** Structural applicability of a field — mirrors research-agent's applicableDimensions. */
export type SymbolShape = "equity" | "etf" | "adr" | "metal";

export interface ScorerFieldContract {
  /** Canonical field id. Stable across the cutover; used as the guard mask key. */
  fieldId: string;
  /** Scoring dimension this field feeds, or null for pure gate/narrative fields. */
  dimension: ScoreDimension | null;
  intent: EvidenceIntent;
  /** The class this field REQUIRES its intent to have before it may be routed. */
  requiredClass: IntentClass;
  markets: readonly Market[];
  /**
   * Symbol shapes for which this field is structurally applicable. A field that
   * is not applicable can never be "degraded" — absence is expected, and the
   * availability mask already renormalizes around it.
   */
  applicableShapes: readonly SymbolShape[];
  /**
   * REQUIRED means: a new long may not be opened while this field is applicable
   * but unusable. §6.4 — this gate OVERRIDES the generic two-dimension floor.
   * Everything else is optional evidence: its absence renormalizes, as today.
   */
  required: boolean;
  /** Minimum field contract — canonical payload paths that must be present and non-null. */
  minFields: readonly string[];
  /** Extra structural minimum (e.g. bar count) beyond mere presence. */
  minCount?: number;
  /** Quality states this field may be scored on. Anything else = unusable. */
  acceptableQuality: readonly EvidenceQuality[];
  /** Freshness ceiling in seconds. Older than this = unusable, never "neutral". */
  maxAgeSeconds: number;
  /** Bases that are semantically interchangeable for this field. Nothing else is. */
  allowedBases: readonly MetricBasis[];
  unit: FieldUnit;
  /** Where the pre-router path gets this today — the compatibility mapping (§8.1). */
  legacy: { module: string; symbol: string; qualityFlag: string };
  note: string;
}

const DAY = 86_400;

export const SCORER_FIELD_CONTRACTS: readonly ScorerFieldContract[] = [
  {
    fieldId: "technical.daily_bars",
    dimension: "technical",
    intent: "price.daily_bars",
    requiredClass: "score_affecting",
    markets: ["us", "india"],
    applicableShapes: ["equity", "etf", "adr", "metal"],
    // Every tradable symbol has a price series. Without >=15 usable bars there
    // is no real RSI(14)/EMA20 — the legacy path already refuses to count that
    // as evidence, so a missing series is a hard abstain for NEW longs.
    required: true,
    minFields: ["bars", "count", "adjusted"],
    minCount: 15,
    acceptableQuality: ["fresh", "stale"],
    maxAgeSeconds: 3 * DAY,
    // eod only. NO tolerance to spot/intraday: a spot-vs-eod swap silently
    // changes every indicator.
    allowedBases: ["eod"],
    unit: "currency",
    legacy: { module: "lib/data/candles.ts", symbol: "fetchUsCandles", qualityFlag: "dataQuality.technicalDataPoints >= 15" },
    note: "Required gate field. Adjusted vs unadjusted is a hard mismatch, never a tolerance.",
  },
  {
    fieldId: "fundamental.reported_core",
    dimension: "fundamental",
    intent: "fundamentals.reported",
    requiredClass: "score_affecting",
    markets: ["us", "india"],
    // ETFs have no company financials; metals none. Structurally N/A, not degraded.
    applicableShapes: ["equity", "adr"],
    // Required for an individual equity: a long on a company with no readable
    // financials is exactly the case §6 exists to stop.
    required: true,
    minFields: ["PERatio", "ProfitMargin", "ReturnOnEquityTTM", "EPS", "QuarterlyRevenueGrowthYOY"],
    // Legacy hasMinFundamentalFields() requires >=2 of the 5 present.
    minCount: 2,
    acceptableQuality: ["fresh", "stale", "partial"],
    maxAgeSeconds: 45 * DAY,
    // TTM and annual/quarterly are NOT interchangeable. The contract pins TTM;
    // a quarterly-only provider (Webull) must pass explicit evaluation first.
    allowedBases: ["ttm"],
    unit: "ratio",
    legacy: { module: "lib/data/scores.ts", symbol: "hasMinFundamentalFields", qualityFlag: "dataQuality.fundamentalDataAvailable" },
    note: "Required gate field for equities. Webull fundamentals are QUARTERLY — a basis mismatch, not a tolerance.",
  },
  {
    fieldId: "fundamental.valuation",
    dimension: "fundamental",
    intent: "fundamentals.valuation",
    requiredClass: "score_affecting",
    markets: ["us", "india"],
    applicableShapes: ["equity", "adr"],
    // Optional: the legacy path folds valuation into the same overview map and
    // scores without it. Its absence renormalizes, as today.
    required: false,
    minFields: ["PERatio"],
    acceptableQuality: ["fresh", "stale", "partial"],
    maxAgeSeconds: 14 * DAY,
    allowedBases: ["ttm"],
    unit: "ratio",
    legacy: { module: "lib/data/scores.ts", symbol: "scoreFundamentals", qualityFlag: "dataQuality.fundamentalDataAvailable" },
    note: "Forward multiples are a different basis — never compared under tolerance against TTM.",
  },
  {
    fieldId: "sentiment.news_tone",
    dimension: "sentiment",
    intent: "sentiment.news",
    requiredClass: "score_affecting",
    markets: ["us", "india"],
    applicableShapes: ["equity", "etf", "adr"],
    // Genuinely sparse (India GDELT barely covers NSE names). Expected absence —
    // requiring it would abstain on healthy runs.
    required: false,
    minFields: ["score", "has_data"],
    acceptableQuality: ["fresh", "stale", "partial"],
    maxAgeSeconds: 3 * DAY,
    allowedBases: ["spot"],
    unit: "ratio",
    legacy: { module: "lib/data/scores.ts", symbol: "scoreSentiment", qualityFlag: "dataQuality.sentimentDataAvailable" },
    note: "Optional. EXPECTED_SPARSE for india:sentiment.",
  },
  {
    fieldId: "insider.net_flow",
    dimension: "insider",
    intent: "insider.transactions",
    requiredClass: "score_affecting",
    markets: ["us", "india"],
    // No Form 4 for ETFs or US ADRs.
    applicableShapes: ["equity"],
    // Sparse by nature — most names have <3 open-market trades in 90d.
    required: false,
    minFields: ["netBuySell", "score"],
    acceptableQuality: ["fresh", "stale", "partial"],
    maxAgeSeconds: 7 * DAY,
    allowedBases: ["spot"],
    unit: "ratio",
    legacy: { module: "lib/data/massive-insider.ts", symbol: "scoreMassiveInsider", qualityFlag: "dataQuality.insiderDataAvailable" },
    note: "Optional. EXPECTED_SPARSE for us:insider.",
  },
  {
    fieldId: "macro.regime",
    dimension: "macro",
    intent: "macro.regime_inputs",
    requiredClass: "score_affecting",
    // US-only: matches INTENT_CATALOG and INTENT_CLASSIFICATION above.
    // India macro is structurally inapplicable; applicableDimensions() in
    // research-agent.ts excludes it, fetchMacroScore() returns available:false,
    // and persistObservedResearchEvidence() never writes India macro to cache.
    markets: ["us"],
    applicableShapes: ["equity", "etf", "adr", "metal"],
    // Market-wide and cached; its absence renormalizes across the cohort
    // uniformly, so it cannot single out one symbol's eligibility.
    required: false,
    minFields: ["regime", "score"],
    acceptableQuality: ["fresh", "stale"],
    // MacroSentinel is weekly; align with the production scorer's bounded
    // weekly fallback instead of declaring healthy mid-week evidence stale.
    maxAgeSeconds: 10 * DAY,
    allowedBases: ["spot"],
    unit: "ratio",
    legacy: { module: "lib/data/scores.ts", symbol: "scoreMacro", qualityFlag: "dataQuality.macroDataAvailable" },
    note: "Market-wide (no symbol). Optional.",
  },
  {
    fieldId: "analyst.consensus_narrative",
    // NO dimension: §3 — US analyst data is narrative only. It must never be
    // wired to a scoring dimension, and India's absence is not a gap.
    dimension: null,
    intent: "analyst.consensus",
    requiredClass: "narrative_only",
    markets: ["us"],
    applicableShapes: ["equity", "adr"],
    required: false,
    minFields: ["rating"],
    acceptableQuality: ["fresh", "stale", "partial"],
    maxAgeSeconds: 14 * DAY,
    allowedBases: ["forward"],
    unit: "text",
    legacy: { module: "lib/research-agent.ts", symbol: "webullAnalystLine", qualityFlag: "(none — narrative)" },
    note: "Thesis-prompt grounding only. Never a cutover blocker; India parity not required.",
  },
];

const BY_FIELD_ID = new Map(SCORER_FIELD_CONTRACTS.map((c) => [c.fieldId, c]));

export function fieldContract(fieldId: string): ScorerFieldContract | undefined {
  return BY_FIELD_ID.get(fieldId);
}

/** Field contracts applicable to a given market + symbol shape. */
export function contractsFor(market: Market, shape: SymbolShape): ScorerFieldContract[] {
  return SCORER_FIELD_CONTRACTS.filter(
    (c) => c.markets.includes(market) && c.applicableShapes.includes(shape),
  );
}

/** The subset that gates a NEW long (§6.4 — overrides the two-dimension floor). */
export function requiredFieldsFor(market: Market, shape: SymbolShape): ScorerFieldContract[] {
  return contractsFor(market, shape).filter((c) => c.required);
}

/**
 * Consistency invariant, asserted by tests: a field that feeds a scoring
 * dimension must declare `requiredClass: "score_affecting"` AND its intent must
 * actually classify that way in every market it claims. This is what stops a
 * narrative intent from quietly acquiring a dimension.
 */
export function contractClassViolations(): string[] {
  const out: string[] = [];
  for (const c of SCORER_FIELD_CONTRACTS) {
    if (c.dimension && c.requiredClass !== "score_affecting") {
      out.push(`${c.fieldId}: has dimension "${c.dimension}" but requiredClass is "${c.requiredClass}"`);
    }
    if (!c.dimension && c.requiredClass === "score_affecting") {
      out.push(`${c.fieldId}: requiredClass score_affecting but feeds no dimension`);
    }
    for (const m of c.markets) {
      const actual = classifyIntent(c.intent, m);
      if (actual !== c.requiredClass) {
        out.push(`${c.fieldId}: market ${m} classifies ${c.intent} as "${actual}", contract requires "${c.requiredClass}"`);
      }
    }
    if (c.required && !c.dimension) {
      out.push(`${c.fieldId}: a narrative/gate-only field may not be marked required`);
    }
  }
  return out;
}
