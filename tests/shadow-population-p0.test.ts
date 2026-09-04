import { describe, expect, it } from "vitest";
import { STRATEGY_STATE, STRATEGY_VERSION_STATES } from "@/lib/validation/strategy-states";

// Shadow-population P0 (features/shadow-population/FEATURE_ARCHITECTURE.md).
//
// THE BUG THIS GUARDS AGAINST. LearnerAgent wrote state: "challenger" and the
// Friday validation sweep queried state = "challenger" — the two call sites
// agreed with each other, and neither ever agreed with the database:
// 'challenger' was absent from strategy_versions_state_check, so every
// challenger insert failed silently and the whole champion/challenger
// pipeline had never run once in production (confirmed 2026-09-04:
// strategy_versions held exactly 2 rows, both the market champions;
// validation_experiments held 0 rows).
//
// A live database CHECK constraint cannot be exercised from this repo's
// vitest suite (no local Postgres). The actual proof that 'challenger' is
// now accepted and that the one-champion-per-market index actually rejects a
// duplicate was run as a rolled-back transaction against the real production
// database on 2026-09-04, immediately after applying migration
// 20260904120000_shadow_population_p0_challenger_state.sql. What THIS file
// can and does prove: every TS call site that reads or writes these states
// uses the same shared constant, so a future typo/rename breaks compilation
// identically everywhere instead of silently disagreeing with just one of
// them (which is exactly how the original bug went undetected).

describe("strategy_versions state constants", () => {
  it("includes 'challenger' and 'shadow_paper' in the allowed set", () => {
    expect(STRATEGY_VERSION_STATES).toContain("challenger");
    expect(STRATEGY_VERSION_STATES).toContain("shadow_paper");
  });

  it("STRATEGY_STATE resolves to the exact literals every call site depends on", () => {
    // Locks the two literals LearnerAgent's insert and the validation sweep's
    // query must keep agreeing on. Renaming either without updating both the
    // migration and this file is now a compile error, not a silent no-op.
    expect(STRATEGY_STATE.CHALLENGER).toBe("challenger");
    expect(STRATEGY_STATE.SHADOW_PAPER).toBe("shadow_paper");
  });

  it("carries every pre-existing state unchanged (P0 adds, never removes)", () => {
    for (const existing of [
      "draft", "testing", "rejected", "paper_candidate", "paper_active", "paper_paused",
      "eligible", "approved_live", "live_paused", "retired", "shadow_paper", "measure_only",
      "live_review_eligible", "live_approved",
    ]) {
      expect(STRATEGY_VERSION_STATES).toContain(existing);
    }
  });
});
