// The cohort a predictive claim is allowed to be made about.
//
// WHY THIS FILE EXISTS
// On 2026-08-28 two published diagnoses were retracted because their rank IC was
// computed over every scored name rather than over the names the system could
// actually buy. The gap is not cosmetic:
//
//   india h10 rank IC   all-scored +0.1046   eligible-long -0.0083   (17 dates)
//   us    h10 rank IC   all-scored -0.0101   eligible-long -0.0768   (21 dates)
//
// A score measured on a population that includes `neutral` and `short`
// observations is measuring a ranking nobody acts on. Every predictive number
// that informs a weight, an archetype grade, or an owner-facing verdict must be
// computed on this cohort; the all-scored number may still be REPORTED, but only
// as explicitly-labelled context.
//
// Both conditions are required even though production currently satisfies
// `entry_eligible = true` if and only if `direction = 'long'` (verified
// 2026-08-28 across all 6,592 decision_observations rows, zero exceptions).
// Relying on that invariant silently would make an eligibility-rule change
// re-contaminate the cohort with no test failing.
export const ENTRY_COHORT_KEY = "eligible_long";
export const ALL_SCORED_COHORT_KEY = "all_scored";

export type DecisionContext = "entry_candidate" | "holding_review" | "unknown";

const HOLDING_SOURCES = new Set(["holding", "india_holding"]);
const ENTRY_SOURCES = new Set([
  "watchlist",
  "carry_forward",
  "screener_momentum",
  "screener_value",
  "metals_basket",
  "crypto_basket",
  "region_etf",
  "india_screener",
  "edge_relative_strength",
  "manual",
]);

/**
 * Resolve immutable decision intent. New rows must carry decisionContext.
 * discoverySource is accepted only to make frozen legacy evidence usable and
 * never turns an unknown source into an entry observation.
 */
export function resolveDecisionContext(
  decisionContext: unknown,
  discoverySource?: unknown,
): DecisionContext {
  if (decisionContext === "entry_candidate" || decisionContext === "holding_review") {
    return decisionContext;
  }
  if (typeof discoverySource !== "string") return "unknown";
  if (HOLDING_SOURCES.has(discoverySource)) return "holding_review";
  if (ENTRY_SOURCES.has(discoverySource)) return "entry_candidate";
  return "unknown";
}

export function isEligibleLong(entryEligible: unknown, direction: unknown): boolean {
  return entryEligible === true && direction === "long";
}

export function isEntryCandidateLong(input: {
  entryEligible: unknown;
  direction: unknown;
  decisionContext?: unknown;
  discoverySource?: unknown;
}): boolean {
  return resolveDecisionContext(input.decisionContext, input.discoverySource) === "entry_candidate"
    && isEligibleLong(input.entryEligible, input.direction);
}

export function isHoldingReview(input: {
  decisionContext?: unknown;
  discoverySource?: unknown;
}): boolean {
  return resolveDecisionContext(input.decisionContext, input.discoverySource) === "holding_review";
}
