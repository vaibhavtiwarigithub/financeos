import { describe, expect, it } from "vitest";
import { benefitVerdictFromPairedAttribution } from "@/lib/shadows/attribution";

describe("Upgrade Path benefit verdict", () => {
  it("never treats raw or missing evidence as a benefit verdict", () => {
    expect(benefitVerdictFromPairedAttribution({
      state: "producer_missing", ciLowerPct: 1, ciUpperPct: 2, independentSessions: 20,
    })).toBe("insufficient");
    expect(benefitVerdictFromPairedAttribution({
      state: "measured", ciLowerPct: null, ciUpperPct: null, independentSessions: 20,
    })).toBe("insufficient");
  });

  it("uses the paired interval, not the point estimate, to grade direction", () => {
    expect(benefitVerdictFromPairedAttribution({
      state: "measured", ciLowerPct: 0.2, ciUpperPct: 1.1, independentSessions: 20,
    })).toBe("promising");
    expect(benefitVerdictFromPairedAttribution({
      state: "measured", ciLowerPct: -1.1, ciUpperPct: -0.2, independentSessions: 20,
    })).toBe("not_beneficial");
    expect(benefitVerdictFromPairedAttribution({
      state: "measured", ciLowerPct: -0.2, ciUpperPct: 1.1, independentSessions: 20,
    })).toBe("insufficient");
  });

  it("does not promote a measured but too-thin paired sample", () => {
    expect(benefitVerdictFromPairedAttribution({
      state: "measured", ciLowerPct: 0.2, ciUpperPct: 1.1, independentSessions: 1,
    })).toBe("insufficient");
  });
});
