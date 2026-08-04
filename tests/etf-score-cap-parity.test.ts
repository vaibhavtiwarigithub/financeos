import { describe, expect, it } from "vitest";
import { ETF_SCORE_CAP, capEtfLikeScore } from "@/lib/scoring/archetypes";

// Regression for the Evidence Router's dominant US parity failure.
//
// Production caps ETF-like scores at 65 (research-agent.ts, after the weighted
// score). The dual-run evaluation called computeWeightedAnalystScore directly
// and skipped the cap, so the legacy-reproduction proof compared a capped
// recorded score against an uncapped replay and declared the legacy leg
// irreproducible — the harness accusing itself of a bug it had.
//
// Measured in production on 2026-08-03, verbatim from evidence_policy_evaluations:
//   VTV  recorded=65 replayed=76      EUAD recorded=65 replayed=82
//   IVV  recorded=65 replayed=72      FEZ  recorded=65 replayed=75
describe("ETF score cap parity between production and the router evaluation", () => {
  const isEtfLike = (shape: string) => shape === "etf" || shape === "metal";

  it("reproduces the four production failures once the cap is applied", () => {
    for (const [, replayed] of [["VTV", 76], ["IVV", 72], ["EUAD", 82], ["FEZ", 75]] as const) {
      expect(capEtfLikeScore(replayed, isEtfLike("etf"))).toBe(65);
    }
  });

  it("caps metal funds too — production sets isEtf:true on the metals basket", () => {
    // symbolShapeOf checks isMetal FIRST, so a metal fund never reports "etf"
    // even though production treats it as one. Keying the cap on "etf" alone
    // would leave GLD/SLV uncapped and reopen the same failure.
    expect(capEtfLikeScore(82, isEtfLike("metal"))).toBe(65);
  });

  it("leaves equities and ADRs untouched", () => {
    expect(capEtfLikeScore(93, isEtfLike("equity"))).toBe(93);
    expect(capEtfLikeScore(78, isEtfLike("adr"))).toBe(78);
  });

  it("does not raise a score already below the cap", () => {
    expect(capEtfLikeScore(41, true)).toBe(41);
    expect(capEtfLikeScore(ETF_SCORE_CAP, true)).toBe(ETF_SCORE_CAP);
  });
});
