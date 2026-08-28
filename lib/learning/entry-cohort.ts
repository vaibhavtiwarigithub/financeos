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

export function isEligibleLong(entryEligible: unknown, direction: unknown): boolean {
  return entryEligible === true && direction === "long";
}
