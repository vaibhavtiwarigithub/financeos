// Build 5 — data-provider confidence enforcement.
//
// The single source of truth for excluding tainted trades from the learning
// loop. Taint columns (data_confidence / tainted / excluded_from_learning)
// were added measure-only by migrations 116/117; this filter is where the
// weight-mutation learner actually HONORS them.
//
// Semantics (fail-open on unknown, fail-closed on known-bad):
//   - excluded_from_learning = true  -> a data-integrity problem was detected
//     on the trade's inputs; DROP it from correlation / weight mutation.
//   - excluded_from_learning = false -> vetted clean; KEEP.
//   - excluded_from_learning IS NULL -> pre-migration-116 rows that were never
//     stamped; treat as trusted and KEEP (dropping them would silently starve
//     the learner of all historical trades).
//
// Only an explicit `true` is excluded. Keeping the string in one place means
// the learner reads and the golden test can never drift apart.
export const LEARNING_TAINT_OR =
  "excluded_from_learning.is.null,excluded_from_learning.eq.false";

// Apply the taint exclusion to a supabase/PostgREST query builder. Returns the
// same builder so it composes in a `.select(...).gte(...)` chain.
export function applyLearningTaintFilter<T extends { or: (f: string) => T }>(qb: T): T {
  return qb.or(LEARNING_TAINT_OR);
}
