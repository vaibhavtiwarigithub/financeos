import { describe, expect, it } from "vitest";
import { isEntryCandidateLong, isHoldingReview, resolveDecisionContext } from "./entry-cohort";

describe("decision cohort", () => {
  it("does not mistake an eligible held-position review for an entry candidate", () => {
    expect(isEntryCandidateLong({
      entryEligible: true,
      direction: "long",
      decisionContext: "holding_review",
      discoverySource: "holding",
    })).toBe(false);
    expect(isHoldingReview({ decisionContext: "holding_review" })).toBe(true);
  });

  it("uses immutable intent before legacy discovery provenance", () => {
    expect(resolveDecisionContext("entry_candidate", "holding")).toBe("entry_candidate");
    expect(resolveDecisionContext("holding_review", "watchlist")).toBe("holding_review");
  });

  it("maps only known legacy sources and fails unknown sources closed", () => {
    expect(resolveDecisionContext(null, "holding")).toBe("holding_review");
    expect(resolveDecisionContext(null, "screener_momentum")).toBe("entry_candidate");
    expect(resolveDecisionContext(null, "mystery")).toBe("unknown");
    expect(isEntryCandidateLong({ entryEligible: true, direction: "long" })).toBe(false);
  });

  it("requires the original eligibility and direction gates", () => {
    expect(isEntryCandidateLong({ entryEligible: true, direction: "long", decisionContext: "entry_candidate" })).toBe(true);
    expect(isEntryCandidateLong({ entryEligible: false, direction: "long", decisionContext: "entry_candidate" })).toBe(false);
    expect(isEntryCandidateLong({ entryEligible: true, direction: "short", decisionContext: "entry_candidate" })).toBe(false);
  });
});
