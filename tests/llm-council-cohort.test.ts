import { describe, expect, it } from "vitest";
import { isNearThresholdEntryLong, thresholdDistance } from "@/lib/llm-council/cohort";

describe("LLM council predeclared near-threshold cohort", () => {
  const base = { analyst_score: 60, score_threshold: 60, direction: "long", decision_context: "entry_candidate" };

  it("includes eligible and rejected long-entry observations within the fixed inclusive band", () => {
    expect(isNearThresholdEntryLong({ ...base, analyst_score: 55, entry_eligible: false } as any)).toBe(true);
    expect(isNearThresholdEntryLong({ ...base, analyst_score: 65, entry_eligible: true } as any)).toBe(true);
    expect(isNearThresholdEntryLong({ ...base, analyst_score: 65.01 } as any)).toBe(false);
  });

  it("excludes holdings, shorts, unknown contexts, and malformed thresholds", () => {
    expect(isNearThresholdEntryLong({ ...base, decision_context: "holding_review" })).toBe(false);
    expect(isNearThresholdEntryLong({ ...base, direction: "short" })).toBe(false);
    expect(isNearThresholdEntryLong({ ...base, decision_context: null, discovery_source: null })).toBe(false);
    expect(isNearThresholdEntryLong({ ...base, score_threshold: null })).toBe(false);
  });

  it("ranks the nearest threshold candidates first", () => {
    expect(thresholdDistance({ ...base, analyst_score: 61 })).toBe(1);
  });
});
