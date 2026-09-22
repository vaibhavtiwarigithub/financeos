import { describe, it, expect } from "vitest";
import { resolveDecisionContext, isEntryCandidateLong, isHoldingReview } from "@/lib/learning/entry-cohort";

describe("resolveDecisionContext", () => {
  it("prefers an explicit decisionContext over discoverySource", () => {
    expect(resolveDecisionContext("entry_candidate", "holding")).toBe("entry_candidate");
    expect(resolveDecisionContext("holding_review", "watchlist")).toBe("holding_review");
  });

  it("falls back to discoverySource for legacy rows with no decisionContext (2026-09-22 regression)", () => {
    // capital-rotation.ts's loadRotationScoreEdgeEvidence checked
    // `row.decision_context === "holding_review"` directly, bypassing this
    // fallback for every pre-decision_context row -- discovery_source='holding'
    // with decision_context=null never classified as a holding, so the
    // candidate/holding pairing loop always ran over zero holdings and
    // score_to_return_mapping stayed stuck at pairCount=0 for two months.
    expect(resolveDecisionContext(null, "holding")).toBe("holding_review");
    expect(resolveDecisionContext(null, "india_holding")).toBe("holding_review");
    expect(resolveDecisionContext(null, "watchlist")).toBe("entry_candidate");
    expect(resolveDecisionContext(null, "screener_momentum")).toBe("entry_candidate");
  });

  it("never turns an unrecognized or missing source into an entry observation", () => {
    expect(resolveDecisionContext(null, null)).toBe("unknown");
    expect(resolveDecisionContext(null, undefined)).toBe("unknown");
    expect(resolveDecisionContext(null, "some_future_source")).toBe("unknown");
    expect(resolveDecisionContext(undefined, 123)).toBe("unknown");
  });
});

describe("isEntryCandidateLong / isHoldingReview parity", () => {
  it("classify the exact same legacy row consistently with each other", () => {
    // The bug class this guards against: one predicate using the shared
    // resolver and the other using a bare equality check on decisionContext
    // alone. Both predicates must resolve through the same fallback so a
    // legacy row is never silently invisible to one side of a candidate/
    // holding pairing.
    const legacyHolding = { entryEligible: true, direction: "long" as const, decisionContext: null, discoverySource: "holding" };
    expect(isHoldingReview(legacyHolding)).toBe(true);
    expect(isEntryCandidateLong(legacyHolding)).toBe(false);

    const legacyCandidate = { entryEligible: true, direction: "long" as const, decisionContext: null, discoverySource: "watchlist" };
    expect(isEntryCandidateLong(legacyCandidate)).toBe(true);
    expect(isHoldingReview(legacyCandidate)).toBe(false);
  });

  it("requires entry_eligible=true and direction=long for a candidate even with a matching source", () => {
    expect(isEntryCandidateLong({ entryEligible: false, direction: "long", discoverySource: "watchlist" })).toBe(false);
    expect(isEntryCandidateLong({ entryEligible: true, direction: "short", discoverySource: "watchlist" })).toBe(false);
  });

  it("holding review does not depend on eligibility (a held position may no longer be eligible)", () => {
    expect(isHoldingReview({ decisionContext: null, discoverySource: "holding" })).toBe(true);
  });
});
