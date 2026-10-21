import { describe, expect, it } from "vitest";
import { activeScoredDimensions, applicableResearchDimensions, availableScoredDimensions, dimensionApplicability } from "@/lib/scoring/dimension-applicability";
import { computeWeightedAnalystScore, SCORE_DIMENSIONS, type DimensionRecord } from "@/lib/scoring/weighted-score";

const weights = { fundamental: 0.3, technical: 0.25, sentiment: 0.2, macro: 0.15, insider: 0.1 };
const scores = { fundamental: 55, technical: 90, sentiment: 80, macro: 70, insider: 50 };

describe("per-instrument score dimension applicability", () => {
  it.each(["SOXL", "SOXS", "TQQQ", "SQQQ", "GLD", "SLV", "USO"])(
    "%s does not treat fund fundamentals or company insider data as applicable",
    (symbol) => {
      const applicability = dimensionApplicability({ symbol, market: "us", isEtf: true });
      expect(applicability.fundamental.state).toBe("not_applicable");
      expect(applicability.insider.state).toBe("not_applicable");
      expect(activeScoredDimensions(applicability)).not.toContain("fundamental");
      expect(activeScoredDimensions(applicability)).not.toContain("insider");
      expect(applicability.technical.state).toBe("applicable");
    },
  );

  it("keeps company fundamentals and the supported dimensions active for a US operating company", () => {
    const applicability = dimensionApplicability({ symbol: "AAPL", market: "us" });
    expect(activeScoredDimensions(applicability)).toEqual(new Set([
      "fundamental", "technical", "sentiment", "macro", "insider",
    ]));
  });

  it("keeps ADS-safe fundamentals for ADRs but excludes the unsupported Form 4 contract", () => {
    const applicability = dimensionApplicability({ symbol: "TSM", market: "us" });
    expect(applicability.fundamental.state).toBe("applicable");
    expect(applicability.insider.state).toBe("not_applicable");
  });

  it("does not label India feeds as structurally meaningless when they are simply not enabled", () => {
    const applicability = dimensionApplicability({ symbol: "RELIANCE.NS", market: "india" });
    expect(applicability.fundamental.state).toBe("applicable");
    expect(applicability.technical.state).toBe("applicable");
    expect(applicability.sentiment.state).toBe("not_enabled");
    expect(applicability.macro.state).toBe("not_enabled");
    expect(applicability.insider.state).toBe("not_enabled");
  });

  it("treats India-listed ETFs as funds and not as companies", () => {
    const applicability = dimensionApplicability({ symbol: "GOLDBEES.NS", market: "india", isEtf: true });
    expect(applicability.fundamental.state).toBe("not_applicable");
    expect(activeScoredDimensions(applicability)).toEqual(new Set(["technical"]));
  });

  it("does not collect company-only evidence for a canonical ETF when caller metadata is missing", () => {
    const dimensions = applicableResearchDimensions({ symbol: "GOLDBEES.NS", market: "india", isEtf: false });
    expect(dimensions).toEqual(new Set(["technical"]));
    const usFundDimensions = applicableResearchDimensions({ symbol: "SOXL", market: "us", isEtf: false });
    expect(usFundDimensions).not.toContain("options");
    expect(usFundDimensions).not.toContain("analyst");
  });

  it("never admits a present feed when that dimension is structurally excluded", () => {
    const applicability = dimensionApplicability({ symbol: "RELIANCE.NS", market: "india" });
    const included = availableScoredDimensions(applicability, {
      fundamental: true, technical: true, sentiment: true, macro: true, insider: true,
    });
    expect(included).toEqual({
      fundamental: true, technical: true, sentiment: false, macro: false, insider: false,
    });
  });

  it("keeps crypto on technical/sentiment/macro evidence, not company ROE or insider factors", () => {
    const applicability = dimensionApplicability({ symbol: "BTC-USD", market: "us" });
    expect(applicability.fundamental.state).toBe("not_applicable");
    expect(applicability.insider.state).toBe("not_applicable");
    expect(activeScoredDimensions(applicability)).toEqual(new Set(["technical", "sentiment", "macro"]));
  });

  it("excludes the REIT neutral placeholder until a qualified FFO/AFFO score exists", () => {
    const applicability = dimensionApplicability({
      symbol: "O",
      market: "us",
      fundamentalEvidence: { applicability: "not_enabled", note: "REIT neutral 55 baseline" },
    });
    expect(applicability.fundamental.state).toBe("not_enabled");
    const active = activeScoredDimensions(applicability);
    const included: DimensionRecord<boolean> = Object.fromEntries(
      SCORE_DIMENSIONS.map((dim) => [dim, active.has(dim)]),
    ) as DimensionRecord<boolean>;
    const result = computeWeightedAnalystScore(scores, included, weights);
    expect(result.includedDims).not.toContain("fundamental");
    expect(result.effWeights.fundamental).toBe(0);
  });
});
