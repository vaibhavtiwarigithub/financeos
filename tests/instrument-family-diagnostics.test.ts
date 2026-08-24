import { describe, expect, it } from "vitest";
import { buildInstrumentFamilyDiagnostics } from "@/lib/scoring/instrument-family-diagnostics";

describe("instrument-family diagnostics", () => {
  it("keeps only the latest same-symbol same-session observation", () => {
    const base = { market: "us" as const, symbol: "GLD", family: "gold_bullion_fund", exposureId: "gold_spot", labels: {} };
    const result = buildInstrumentFamilyDiagnostics([
      { ...base, observationId: 1, ts: "2026-08-24T14:00:00Z", score: 61 },
      { ...base, observationId: 2, ts: "2026-08-24T18:00:00Z", score: 65 },
    ])[0];
    expect(result.independentSymbolSessions).toBe(1);
    expect(result.score.min).toBe(65);
  });

  it("does not count substitute vehicles as independent exposure sessions", () => {
    const rows = ["GLD", "IAU"].map((symbol, index) => ({
      observationId: index + 1, market: "us" as const, symbol,
      family: "gold_bullion_fund", exposureId: "gold_spot",
      ts: "2026-08-24T18:00:00Z", score: 65, labels: { 5: 0.01 },
    }));
    const result = buildInstrumentFamilyDiagnostics(rows)[0];
    expect(result.independentSymbolSessions).toBe(2);
    expect(result.independentExposureSessions).toBe(1);
    expect(result.matureLabels[5]).toBe(1);
    expect(result.readyForIc).toBe(false);
    expect(result.abstentionReasons.join(" ")).toContain("needs 60");
  });
});
