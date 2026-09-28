import { describe, expect, it } from "vitest";
import { summarizeAttribution } from "@/lib/shadows/summary";

describe("Upgrade Path attribution summary", () => {
  it("counts performance evidence independently from operational-only programs", () => {
    const summary = summarizeAttribution([
      { attribution: { comparisonType: "matched_replay", state: "producer_missing" } },
      { attribution: { comparisonType: "paper_cohort", state: "collecting" } },
      { attribution: { comparisonType: "matched_replay", state: "measured", measurementScope: "synthetic_diagnostic" } },
      { attribution: { comparisonType: "matched_replay", state: "invalid" } },
      { attribution: { comparisonType: "operational_only", state: "not_attributable" } },
    ]);
    expect(summary).toEqual({
      performanceEligible: 4, measured: 1, syntheticMeasured: 1, collecting: 1, producerMissing: 1, invalid: 1, notAttributable: 1,
    });
    expect(summary.measured + summary.collecting + summary.producerMissing + summary.invalid).toBe(summary.performanceEligible);
  });

  it("does not count an operational lifecycle state as P&L collection", () => {
    expect(summarizeAttribution([
      { attribution: { comparisonType: "operational_only", state: "not_attributable" } },
    ])).toMatchObject({ performanceEligible: 0, collecting: 0, producerMissing: 0, notAttributable: 1 });
  });
});
