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
}

export function routeToArchetypes(input: ArchetypeRouterInput): ArchetypeConfig[] {
  const { isEtf, isIndia, daysToEarnings, fundamentalScore } = input;

  if (isEtf) {
    return [ARCHETYPE_BY_ID.get("etf_trend")!];
  }

  if (isIndia) {
    return [
      ARCHETYPE_BY_ID.get("india_quality_momentum")!,
      ARCHETYPE_BY_ID.get("india_sector_rotation")!,
    ];
  }

  // US equity: quality_momentum always; conditional additions
  const active: ArchetypeConfig[] = [ARCHETYPE_BY_ID.get("quality_momentum")!];
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
