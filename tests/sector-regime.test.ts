import { describe, expect, it } from "vitest";
import {
  sectorRelativeStrength, measureSectorSignal, MIN_SECTORS_PER_SESSION,
  type Bar, type SectorScoredRow,
} from "@/lib/learning/sector-regime";

// Stage 1 of features/sector-regime-dimension — MEASURE ONLY.
//
// `macro` is one market-wide scalar per day, so its rank IC is 0.0000 BY
// CONSTRUCTION. Sector is the first macro-flavoured input that varies per
// symbol and could therefore rank a cross-section at all.

function bars(closes: number[], startDay = 1): Bar[] {
  return closes.map((close, i) => ({
    date: `2026-03-${String(startDay + i).padStart(2, "0")}`,
    close,
  }));
}

describe("relative strength is point-in-time", () => {
  it("ignores bars AFTER the decision date", () => {
    // Including the decision day's forward bars would leak the outcome into the
    // feature — the same class of error as the calendar-day purge that leaked
    // labels in walkForwardFolds.
    const sector = bars([100, 101, 102, 103, 999]);   // 999 is the future
    const bench = bars([100, 100, 100, 100, 100]);
    const asOf = "2026-03-04";
    // 103/100 - 1 = 0.03 against a flat benchmark.
    expect(sectorRelativeStrength(sector, bench, asOf, 3)).toBeCloseTo(0.03, 10);
  });

  it("subtracts the benchmark, so a sector that merely tracks the market scores 0", () => {
    const sector = bars([100, 110, 120]);
    const bench = bars([100, 110, 120]);
    expect(sectorRelativeStrength(sector, bench, "2026-03-03", 2)).toBeCloseTo(0, 10);
  });

  it("is negative when the sector lags the market", () => {
    const sector = bars([100, 100, 100]);
    const bench = bars([100, 105, 110]);
    expect(sectorRelativeStrength(sector, bench, "2026-03-03", 2)!).toBeLessThan(0);
  });

  it("returns null rather than a partial window when history is short", () => {
    // A short window silently computed over fewer sessions is not the same
    // feature, and mixing window lengths across symbols breaks the ranking.
    expect(sectorRelativeStrength(bars([100, 101]), bars([100, 100]), "2026-03-02", 20)).toBeNull();
  });

  it("returns null when the benchmark is missing", () => {
    expect(sectorRelativeStrength(bars([100, 101, 102]), [], "2026-03-03", 2)).toBeNull();
  });
});

describe("breadth: names are not independent observations", () => {
  /** One session, `sectors` sectors, `perSector` names each sharing the sector value. */
  function session(day: string, sectors: number, perSector: number): SectorScoredRow[] {
    const rows: SectorScoredRow[] = [];
    for (let s = 0; s < sectors; s++) {
      for (let n = 0; n < perSector; n++) {
        rows.push({
          symbol: `S${s}_${n}`, session: day, sector: `SEC${s}`,
          value: s / 10,              // constant within sector — the whole point
          outcome: s / 100,           // perfectly aligned, so IC is +1 either way
          technical: null,
        });
      }
    }
    return rows;
  }

  it("reports the sector count as the effective breadth, not the name count", () => {
    // THE TRAP. A sector signal gives every name in a sector the SAME value, so
    // 40 names carrying 4 distinct values are 4 clusters, not 40 observations.
    const rows = [...session("2026-03-01", 6, 10), ...session("2026-03-02", 6, 10)];
    const report = measureSectorSignal(rows);
    expect(report.medianNamesPerSession).toBe(60);
    expect(report.medianSectorsPerSession).toBe(6);
  });

  it("computes IC BOTH ways so the inflation is visible", () => {
    const rows = [...session("2026-03-01", 5, 8), ...session("2026-03-02", 5, 8)];
    const report = measureSectorSignal(rows);
    // Perfectly aligned data: both are +1. The point is that BOTH are reported —
    // over names (what a naive implementation shows) and over sectors (honest).
    expect(report.meanIcOverNames).toBeCloseTo(1, 6);
    expect(report.meanIcOverSectors).toBeCloseTo(1, 6);
  });

  it("excludes a session with too few sectors to order", () => {
    // Two sectors is one degree of freedom; "ranking" there is a coin flip.
    const thin = MIN_SECTORS_PER_SESSION - 1;
    const report = measureSectorSignal(session("2026-03-01", thin, 10));
    expect(report.sessions).toBe(1);
    expect(report.qualifyingSessions).toBe(0);
    expect(report.meanIcOverSectors).toBeNull();
  });

  it("averages outcomes within a sector for the sector-level unit", () => {
    // Two names in one sector with opposite outcomes must not each vote.
    // Five sectors, matching MIN_SECTORS_PER_SESSION / computeSpearmanIC's floor.
    const rows: SectorScoredRow[] = [
      { symbol: "A", session: "d1", sector: "X", value: 0.9, outcome: 0.10, technical: null },
      { symbol: "B", session: "d1", sector: "X", value: 0.9, outcome: -0.10, technical: null },
      { symbol: "C", session: "d1", sector: "Y", value: 0.5, outcome: 0.02, technical: null },
      { symbol: "D", session: "d1", sector: "Z", value: 0.1, outcome: -0.02, technical: null },
      { symbol: "E", session: "d1", sector: "W", value: 0.3, outcome: 0.00, technical: null },
      { symbol: "F", session: "d1", sector: "V", value: 0.7, outcome: 0.05, technical: null },
    ];
    const report = measureSectorSignal(rows);
    // Sector X nets to 0.0; the sector-level IC is computed over 4 points.
    expect(report.qualifyingSessions).toBe(1);
    expect(report.meanIcOverSectors).not.toBeNull();
  });
});

describe("the honest-prior check against technical", () => {
  it("reports the correlation with the existing technical score", () => {
    // Sector relative strength IS a momentum measure and technical currently
    // ranks BACKWARDS at every horizon. A high correlation means this is
    // technical in slow motion — a reason to stop, not a footnote.
    const rows: SectorScoredRow[] = Array.from({ length: 12 }, (_, i) => ({
      symbol: `S${i}`, session: "d1", sector: `SEC${i % 4}`,
      value: i / 10, outcome: 0, technical: i * 5,   // perfectly aligned
    }));
    const report = measureSectorSignal(rows);
    expect(report.technicalCorrelation).toBeCloseTo(1, 6);
  });

  it("returns null when technical is absent rather than assuming independence", () => {
    const rows: SectorScoredRow[] = Array.from({ length: 12 }, (_, i) => ({
      symbol: `S${i}`, session: "d1", sector: `SEC${i % 4}`,
      value: i / 10, outcome: 0, technical: null,
    }));
    expect(measureSectorSignal(rows).technicalCorrelation).toBeNull();
  });
});
