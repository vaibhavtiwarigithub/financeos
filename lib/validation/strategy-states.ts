// Single source of truth for strategy_versions.state string literals.
//
// THE BUG THIS PREVENTS FROM RECURRING. LearnerAgent has always written
// state: "challenger" and the Friday validation sweep has always queried
// state = "challenger" — the two application call sites agreed with each
// other. Neither ever agreed with the database: 'challenger' was never in
// strategy_versions_state_check's allowed list (fixed in migration
// 20260904120000_shadow_population_p0_challenger_state.sql), so every insert
// failed silently at the DB layer and the whole champion/challenger pipeline
// had never run once. A bare string literal repeated at each call site gives
// nothing — not the compiler, not a test — a reason to notice that drift.
//
// This does not, and cannot, verify the literals still match the live
// database CHECK constraint — that requires a real Postgres connection this
// repo's test suite does not have. What it buys: every TS call site now
// reads from ONE array, so a future accidental rename/typo breaks every
// consumer identically (a compile error via the union type) instead of
// silently disagreeing with just the database.
//
// Keep this list in sync with strategy_versions_state_check by hand when
// either changes — there is no automated cross-check.
export const STRATEGY_VERSION_STATES = [
  "draft", "testing", "rejected", "paper_candidate", "paper_active", "paper_paused",
  "eligible", "approved_live", "live_paused", "retired", "shadow_paper", "measure_only",
  "live_review_eligible", "live_approved",
  "challenger",
] as const;

export type StrategyVersionState = (typeof STRATEGY_VERSION_STATES)[number];

export const STRATEGY_STATE = {
  CHALLENGER: "challenger",
  SHADOW_PAPER: "shadow_paper",
} as const satisfies Record<string, StrategyVersionState>;
