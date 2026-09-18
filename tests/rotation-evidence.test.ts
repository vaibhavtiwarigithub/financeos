import { describe, expect, it } from "vitest";
import { hasExactPaperTaxLot, summarizeRotationScoreEdgeEvidence, type RotationScoreOutcome } from "@/lib/trading/rotation-evidence";

function outcomes(sessionCount: number, advantage = 0.02): RotationScoreOutcome[] {
  const rows: RotationScoreOutcome[] = [];
  for (let i = 0; i < sessionCount; i++) {
    const date = new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10);
    rows.push(
      { sessionDate: date, observedAt: `${date}T14:00:00Z`, symbol: `C${i}`, role: "candidate", score: 80, forwardReturn: advantage },
      { sessionDate: date, observedAt: `${date}T14:00:00Z`, symbol: `H${i}`, role: "holding", score: 60, forwardReturn: 0 },
    );
  }
  return rows;
}

describe("rotation score-edge evidence", () => {
  it("does not promote overlapping daily label windows as independent evidence", () => {
    const result = summarizeRotationScoreEdgeEvidence(outcomes(20), { minScoreEdge: 12, horizonDays: 10, requiredIndependentSessions: 3 });
    expect(result.distinctSessions).toBe(20);
    expect(result.independentSessions).toBe(2);
    expect(result.status).toBe("insufficient");
  });

  it("requires a positive conservative lower bound after the independent-session floor", () => {
    const result = summarizeRotationScoreEdgeEvidence(outcomes(200), { minScoreEdge: 12, horizonDays: 10, requiredIndependentSessions: 20 });
    expect(result.status).toBe("validated");
    expect(result.lowerConfidenceEdgePct).toBeGreaterThan(0);
    expect(result.meanEdgePct).toBeCloseTo(2, 8);
  });

  it("fails a negative score-edge mapping even after enough sessions", () => {
    const result = summarizeRotationScoreEdgeEvidence(outcomes(200, -0.02), { minScoreEdge: 12, horizonDays: 10, requiredIndependentSessions: 20 });
    expect(result.status).toBe("not_positive");
    expect(result.lowerConfidenceEdgePct).toBeLessThanOrEqual(0);
  });
});

describe("paper exact-lot proof", () => {
  const position = { symbol: "ABC", openedAt: "2026-01-02T15:00:00Z", qty: 3, avgCost: 100 };
  const fill = { symbol: "ABC", createdAt: "2026-01-02T15:00:01Z", qty: 3, fillPrice: 100, fillStatus: "filled" };

  it("accepts one reconciled fill only", () => {
    expect(hasExactPaperTaxLot(position, [fill])).toBe(true);
  });

  it("refuses merged/add-to-position lots", () => {
    expect(hasExactPaperTaxLot(position, [fill, { ...fill, createdAt: "2026-01-03T15:00:00Z" }])).toBe(false);
  });

  it("refuses an unreconciled cost basis", () => {
    expect(hasExactPaperTaxLot(position, [{ ...fill, fillPrice: 99 }])).toBe(false);
  });
});
