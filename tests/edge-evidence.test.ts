import { describe, expect, it } from "vitest";
import { classifyEdgeIC, MIN_IC_OBSERVATIONS } from "@/lib/edges/ic";
import {
  edgeHealthKey,
  inputFingerprint,
  neweyWestLag,
  provenanceMode,
  universeFingerprint,
} from "@/lib/edges/evidence";

describe("edge evidence governance", () => {
  it("does not classify a statistically thin result as shadow eligible", () => {
    expect(classifyEdgeIC(0.08, 4.2, MIN_IC_OBSERVATIONS - 1)).toBe("measure_only");
    expect(classifyEdgeIC(0.08, 4.2, MIN_IC_OBSERVATIONS)).toBe("shadow_eligible");
  });

  it("benches a sufficiently observed negative edge", () => {
    expect(classifyEdgeIC(-0.05, -2.5, MIN_IC_OBSERVATIONS)).toBe("benched_negative");
  });

  it("scales the Newey-West lag to the sampled IC series", () => {
    expect(neweyWestLag(20, 5)).toBe(4);
    expect(neweyWestLag(10, 5)).toBe(2);
    expect(neweyWestLag(5, 5)).toBe(1);
  });

  it("labels explicit historical ranges as retrospective", () => {
    expect(provenanceMode(true)).toBe("retrospective_reconstruction");
    expect(provenanceMode(false)).toBe("prospective_capture");
  });

  it("keeps health keys market isolated", () => {
    expect(edgeHealthKey("scout", "us")).not.toBe(edgeHealthKey("scout", "india"));
    expect(edgeHealthKey("ic", "us")).not.toBe(edgeHealthKey("ic", "india"));
  });

  it("fingerprints provider evidence deterministically and sensitively", () => {
    const base = {
      market: "us" as const,
      symbol: "spy",
      date: "2026-07-18",
      edgeId: "mom_12_1",
      source: "massive",
      rawValue: 0.123,
    };
    expect(inputFingerprint(base)).toBe(inputFingerprint({ ...base, symbol: "SPY" }));
    expect(inputFingerprint(base)).not.toBe(inputFingerprint({ ...base, rawValue: 0.124 }));
    expect(inputFingerprint(base)).not.toBe(inputFingerprint({ ...base, market: "india" }));
  });

  it("fingerprints a universe independent of symbol order but not market", () => {
    expect(universeFingerprint("us", ["MSFT", "AAPL", "MSFT"]))
      .toBe(universeFingerprint("us", ["aapl", "msft"]));
    expect(universeFingerprint("us", ["AAPL", "MSFT"]))
      .not.toBe(universeFingerprint("india", ["AAPL", "MSFT"]));
  });
});
