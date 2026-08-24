import { describe, expect, it } from "vitest";
import {
  assessMacroIndicators,
  computeMacroRegime,
  MACRO_INDICATOR_WEIGHTS,
} from "@/lib/data/macro-regime-integrity";

const indicators = Object.entries(MACRO_INDICATOR_WEIGHTS).map(([name, weight]) => ({
  name, weight, value: 1, signal: "green" as const, description: name,
}));

describe("macro regime integrity", () => {
  it("uses the full structural denominator", () => {
    const stressed = indicators.map((row, index) => ({
      ...row, signal: index === 0 ? "red" as const : "green" as const,
    }));
    // One red high-weight dimension = 9 danger points / 48 structural max.
    expect(computeMacroRegime(stressed).danger_score).toBe(19);
  });

  it("refuses a superficially complete but low-coverage run", () => {
    const result = computeMacroRegime(indicators.slice(0, 5));
    expect(result.regime).toBe("unknown");
    expect(result.danger_score).toBeNull();
  });

  it("does not let duplicates or forged weights inflate coverage", () => {
    const duplicate = { ...indicators[0], weight: 99 };
    const integrity = assessMacroIndicators([...indicators.slice(0, 5), duplicate, duplicate]);
    expect(integrity.indicatorsAvailable).toBe(5);
    expect(integrity.usable).toBe(false);
  });

  it("accepts a complete well-formed run", () => {
    const result = computeMacroRegime(indicators);
    expect(result.regime).toBe("green");
    expect(result.danger_score).toBe(0);
    expect(result.data_confidence).toBe(1);
  });
});
