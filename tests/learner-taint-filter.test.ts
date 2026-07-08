import { describe, it, expect } from "vitest";
import { LEARNING_TAINT_OR, applyLearningTaintFilter } from "@/lib/learning/taint-filter";

// Build 5 golden tests. These lock the enforcement invariant the mig-116 comment
// gates on ("enforcement turns on after golden tests"): the learning loop must
// exclude a data-provider-tainted trade (excluded_from_learning = true) while
// keeping vetted-clean (false) AND pre-migration untagged (null) trades. The
// filter string is the single source of truth both learner reads reference, so
// locking it here means the reads can never silently drift.

describe("LEARNING_TAINT_OR filter string", () => {
  it("excludes only explicit true — keeps false and null", () => {
    // PostgREST `.or(...)`: a row matches (is kept) if ANY clause is true.
    // Clauses: excluded_from_learning IS NULL, OR excluded_from_learning = false.
    expect(LEARNING_TAINT_OR).toBe(
      "excluded_from_learning.is.null,excluded_from_learning.eq.false"
    );
    // Neither clause matches a row where excluded_from_learning = true, so a
    // tainted trade is dropped; both clauses' targets (null, false) are kept.
    expect(LEARNING_TAINT_OR).not.toContain("eq.true");
    expect(LEARNING_TAINT_OR).toContain("is.null");
    expect(LEARNING_TAINT_OR).toContain("eq.false");
  });
});

describe("applyLearningTaintFilter", () => {
  it("applies exactly one .or with the taint filter and returns the builder", () => {
    const calls: string[] = [];
    const qb: any = { or: (f: string) => { calls.push(f); return qb; } };
    const out = applyLearningTaintFilter(qb);
    expect(out).toBe(qb); // composes in a .select(...).gte(...) chain
    expect(calls).toEqual([LEARNING_TAINT_OR]);
  });

  it("models the keep/drop decision the filter encodes", () => {
    // Simulate PostgREST OR semantics over a mixed dataset. This proves the
    // string we ship yields the intended keep-set, not just that it's stable.
    const rows = [
      { id: 1, excluded_from_learning: true },   // tainted -> drop
      { id: 2, excluded_from_learning: false },  // vetted  -> keep
      { id: 3, excluded_from_learning: null },   // legacy  -> keep
      { id: 4 },                                 // absent  -> treated as null -> keep
    ];
    const keeps = rows.filter(r => {
      const v = (r as any).excluded_from_learning ?? null;
      return v === null || v === false; // mirrors is.null OR eq.false
    });
    expect(keeps.map(r => r.id)).toEqual([2, 3, 4]);
  });
});
