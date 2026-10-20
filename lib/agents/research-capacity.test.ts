import { describe, expect, it } from "vitest";
import { newListingObservationCap, researchCandidateCap } from "@/lib/agents/research-capacity";

describe("research candidate capacity defaults", () => {
  it("uses the bounded production defaults when settings are absent or invalid", () => {
    expect(researchCandidateCap("us", {})).toBe(40);
    expect(researchCandidateCap("india", {})).toBe(10);
    expect(researchCandidateCap("india", { RESEARCH_INDIA_CANDIDATE_CAP: "0" })).toBe(10);
    expect(researchCandidateCap("india", { RESEARCH_INDIA_CANDIDATE_CAP: "oops" })).toBe(10);
  });

  it("honors an explicit positive market cap", () => {
    expect(researchCandidateCap("india", { RESEARCH_INDIA_CANDIDATE_CAP: "12" })).toBe(12);
    expect(researchCandidateCap("us", { RESEARCH_CANDIDATE_CAP: "50" })).toBe(50);
  });

  it("defaults new-listing first-look research to four and never exceeds four", () => {
    expect(newListingObservationCap({})).toBe(4);
    expect(newListingObservationCap({ RESEARCH_NEW_LISTING_OBSERVATIONS_PER_RUN: "9" })).toBe(4);
    expect(newListingObservationCap({ RESEARCH_NEW_LISTING_OBSERVATIONS_PER_RUN: "1" })).toBe(1);
    expect(newListingObservationCap({ RESEARCH_NEW_LISTING_OBSERVATIONS_PER_RUN: "-2" })).toBe(0);
    expect(newListingObservationCap({ RESEARCH_NEW_LISTING_OBSERVATIONS_PER_RUN: "bad" })).toBe(4);
  });
});
