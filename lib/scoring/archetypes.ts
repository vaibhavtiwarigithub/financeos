import {
  computeWeightedAnalystScore,
  type DimensionRecord,
  type WeightedScoreResult,
} from "@/lib/scoring/weighted-score";

export type ArchetypeRole = "primary" | "shadow";

export interface ArchetypeConfig {
  id: string;
  label: string;
  weights: DimensionRecord<number>;
  role: ArchetypeRole;
}

export const ARCHETYPES: ArchetypeConfig[] = [
  {
    id: "quality_momentum",
    label: "Quality Momentum",
    weights: { fundamental: 0.25, technical: 0.40, sentiment: 0.15, macro: 0.10, insider: 0.10 },
    role: "primary",
  },
  {
    id: "value_inflection",
    label: "Value Inflection",
    weights: { fundamental: 0.45, technical: 0.25, sentiment: 0.10, macro: 0.10, insider: 0.10 },
    role: "shadow",
  },
  {
    // NAMING-COLLISION FIX (features/known-anomalies §2.7): this archetype is
    // NOT real post-earnings-announcement drift (PEAD). It fires on pre-earnings
    // PROXIMITY (daysToEarnings <= 10, see routeToArchetypes) and merely reweights
    // the existing five scoring dimensions — it has no first-reported-actual vs
    // pre-announcement-consensus surprise input at all. The `post_earnings_drift`
    // / "Post-Earnings Drift" identifiers were misleading and would collide with a
    // future TRUE PEAD edge. Renamed to `pre_earnings_proximity_reweight_v1` so the
    // `pead_*` namespace is reserved for the real surprise-based edge. Behavior
    // (weights, routing threshold, shadow role) is UNCHANGED by this rename.
    id: "pre_earnings_proximity_reweight_v1",
    label: "Pre-Earnings Proximity Reweight",
    weights: { fundamental: 0.20, technical: 0.30, sentiment: 0.35, macro: 0.10, insider: 0.05 },
    role: "shadow",
  },
  {
    id: "etf_trend",
    label: "ETF Trend",
    weights: { fundamental: 0.00, technical: 0.60, sentiment: 0.20, macro: 0.20, insider: 0.00 },
    role: "primary",
  },
  {
    id: "india_quality_momentum",
    label: "India Quality Momentum",
    weights: { fundamental: 0.30, technical: 0.45, sentiment: 0.15, macro: 0.10, insider: 0.00 },
    role: "primary",
  },
  {
    // Deliberate single-dimension arm, added 2026-08-25 to bracket the measured
    // finding that the US composite scores BELOW its own best dimension:
    //   us h10 rank IC   fundamental +0.076 (t=2.40)   composite +0.051 (t=0.93)
    // value_inflection (fundamental 0.45) only half-tests that; this isolates it.
    //
    // CALLER CONTRACT: only score this archetype when `included.fundamental` is
    // true. computeWeightedAnalystScore equal-splits across the included
    // dimensions when every included dimension has weight 0, so scoring this set
    // on a symbol with no fundamental evidence would silently produce an
    // equal-weight technical/sentiment/macro blend -- an arm labelled
    // "fundamental_only" that contains no fundamental at all.
    id: "fundamental_only",
    label: "Fundamental Only (measurement arm)",
    weights: { fundamental: 1.00, technical: 0.00, sentiment: 0.00, macro: 0.00, insider: 0.00 },
    role: "shadow",
  },
  {
    id: "india_sector_rotation",
    label: "India Sector Rotation",
    weights: { fundamental: 0.00, technical: 0.55, sentiment: 0.20, macro: 0.25, insider: 0.00 },
    role: "shadow",
  },
];

const ARCHETYPE_BY_ID = new Map(ARCHETYPES.map(a => [a.id, a]));

export interface ArchetypeRouterInput {
  isEtf: boolean;
  isIndia: boolean;
  daysToEarnings: number | null;
  fundamentalScore: number;
  /** Availability-mask value for the fundamental dimension. The fundamental_only
   *  arm is skipped unless this is explicitly true — a missing flag must not be
   *  read as present. */
  fundamentalAvailable?: boolean;
}

export function routeToArchetypes(input: ArchetypeRouterInput): ArchetypeConfig[] {
  const { isEtf, isIndia, daysToEarnings, fundamentalScore } = input;

  if (isEtf) {
    return [ARCHETYPE_BY_ID.get("etf_trend")!];
  }

  if (isIndia) {
    const indiaActive = [
      ARCHETYPE_BY_ID.get("india_quality_momentum")!,
      ARCHETYPE_BY_ID.get("india_sector_rotation")!,
    ];
    // Same arm for India. The measured India edge sits in TECHNICAL, not
    // fundamental (h10 rank IC technical +0.173 t=2.51, fundamental -0.046),
    // so this arm is expected to score poorly there -- which is the point: an
    // arm that only ever runs where it is expected to win proves nothing.
    if (input.fundamentalAvailable === true) {
      indiaActive.push(ARCHETYPE_BY_ID.get("fundamental_only")!);
    }
    return indiaActive;
  }

  // US equity: quality_momentum always; conditional additions
  const active: ArchetypeConfig[] = [ARCHETYPE_BY_ID.get("quality_momentum")!];
  // Single-dimension measurement arm. Gated on fundamental evidence actually
  // being present -- see the contract note on the archetype itself.
  if (input.fundamentalAvailable === true) {
    active.push(ARCHETYPE_BY_ID.get("fundamental_only")!);
  }
  if (daysToEarnings != null && daysToEarnings <= 10) {
    // Pre-earnings proximity reweight (renamed from the misleading
    // "post_earnings_drift" — see ARCHETYPES comment). Not a PEAD surprise edge.
    active.push(ARCHETYPE_BY_ID.get("pre_earnings_proximity_reweight_v1")!);
  }
  if (fundamentalScore >= 50) {
    active.push(ARCHETYPE_BY_ID.get("value_inflection")!);
  }
  return active;
}

// ponytail: matches the cap in research-agent.ts — ETFs trend cleanly so their
// technical dimension dominates after renorm; cap prevents displacing equity alpha candidates.
export const ETF_SCORE_CAP = 65;

/**
 * The ETF cap exactly as the production scorer applies it
 * (`research-agent.ts` gates on `isEtf`, and metal funds are pushed with
 * `isEtf: true`, so both the "etf" and "metal" shapes are capped).
 *
 * Exported because the Evidence Router's dual-run evaluation must reproduce the
 * production score bit-for-bit. It previously called `computeWeightedAnalystScore`
 * directly and skipped this cap, so every ETF failed the legacy-reproduction
 * check with `recorded=65, replayed=<uncapped>` — 45 failures across 8 symbols,
 * over half of all US parity failures, on a leg that is supposed to prove the
 * harness froze the right mask and weights.
 */
export function capEtfLikeScore(score: number, isEtfLike: boolean): number {
  return isEtfLike ? Math.min(score, ETF_SCORE_CAP) : score;
}

export function computeArchetypeScore(
  archetype: ArchetypeConfig,
  scoreOf: DimensionRecord<number>,
  included: DimensionRecord<boolean>,
): WeightedScoreResult {
  const result = computeWeightedAnalystScore(scoreOf, included, archetype.weights);
  if (archetype.id === "etf_trend") {
    return { ...result, score: Math.min(result.score, ETF_SCORE_CAP) };
  }
  return result;
}
