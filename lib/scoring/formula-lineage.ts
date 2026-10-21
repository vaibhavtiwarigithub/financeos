import { fingerprint } from "@/lib/analytics/alpha-diagnostic-contract";
import { TECHNICAL_FORMULA_VERSION } from "@/lib/data/technicals";

/** Unchanged dimensions are named current baselines from this release onward.
 * These IDs must never be backfilled onto older, unversioned observations.
 */
export const FORMULA_VERSIONS = Object.freeze({
  fundamental: "fundamental_dimension_v1_20261021",
  technical: TECHNICAL_FORMULA_VERSION,
  sentiment: "sentiment_dimension_v1_20261021",
  macro: "macro_dimension_v1_20261021",
  insider: "insider_dimension_v1_20261021",
  composite: "composite_formula_v1_20261021",
});
export const COUNCIL_FORMULA_VERSIONS = Object.freeze({
  output_contract: "council_score_0_100_h10_v1",
  aggregation: "council_median_v1",
  blend_diagnostic: "council_deterministic_equal_weight_v1",
});

export function buildFormulaLineage(configuration: Record<string, unknown>) {
  return {
    manifestVersion: "score-formula-lineage-v1",
    versions: FORMULA_VERSIONS,
    configuration,
    configurationHash: fingerprint({ versions: FORMULA_VERSIONS, configuration }),
    legacyPolicy: "Missing historical lineage is legacy/unknown, not inferred from current code.",
  };
}
