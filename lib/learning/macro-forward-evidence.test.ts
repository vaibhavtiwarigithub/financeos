import { describe, expect, it } from "vitest";
import { buildMacroForwardEvidence } from "@/lib/learning/macro-forward-evidence";

function dateAfter(start: string, days: number): string {
  const date = new Date(`${start}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

describe("macro forward evidence", () => {
  it("uses first-seen India factors only after they were fetched and aggregates symbols by date", () => {
    const labels: any[] = [];
    const factors: any[] = [];
    for (let i = 0; i < 40; i++) {
      const date = dateAfter("2026-01-01", i);
      const ts = `${date}T13:00:00.000Z`;
      factors.push({ series_id: "nifty50_close", obs_date: date, value: 100 + i, fetched_at: `${date}T12:00:00.000Z` });
      const ret = i / 100;
      for (const symbol of ["ITBEES.NS", "BANKBEES.NS"]) {
        labels.push({ horizon_days: 2, benchmark_neutral_return: ret, decision_observations: {
          ts, symbol, market: "india", analyst_score: 60, macro_score: null, availability_mask: { macro: false },
        } });
      }
    }
    // This historical value was fetched later. It must not backfill earlier decisions.
    factors.push({ series_id: "nifty50_close", obs_date: "2026-01-02", value: 999, fetched_at: "2026-03-01T00:00:00.000Z" });

    const cells = buildMacroForwardEvidence("india", labels, factors);
    const nifty = cells.find((cell) => cell.instrumentFamily === "india_etf" && cell.series === "NIFTY 50 daily % change");
    expect(nifty).toBeDefined();
    expect(nifty!.matchedDates).toBe(39);
    expect(nifty!.symbolRows).toBe(78);
    expect(nifty!.horizonSpacedWindows).toBe(20);
    expect(nifty!.spearmanIc).toBeCloseTo(-1, 10);
    expect(nifty!.state).toBe("descriptive");
  });

  it("keeps immature or thin cohorts insufficient and does not invent a zero IC", () => {
    const labels = Array.from({ length: 15 }, (_, i) => {
      const date = dateAfter("2026-03-01", i);
      return { horizon_days: 5, benchmark_neutral_return: i, decision_observations: {
        ts: `${date}T13:00:00.000Z`, symbol: "AAPL", market: "us", macro_score: i, analyst_score: 65,
        availability_mask: { macro: true }, formula_lineage: { versions: { macro: "macro_v2", composite: "composite_v3" } },
      } } as any;
    });
    const cells = buildMacroForwardEvidence("us", labels, []);
    const macro = cells.find((cell) => cell.series === "macro_score");
    expect(macro?.horizonSpacedWindows).toBe(3);
    expect(macro?.spearmanIc).toBe(1);
    expect(macro?.state).toBe("insufficient");
    expect(macro?.formulaVersion).toBe("macro_v2");
    expect(cells.some((cell) => cell.series === "India VIX daily % change")).toBe(false);
  });

  it("does not use India macro observations that were unavailable at the frozen decision", () => {
    const decisionTs = "2026-06-10T13:00:00.000Z";
    const labels: any[] = [{ horizon_days: 2, benchmark_neutral_return: 0.02, decision_observations: {
      ts: decisionTs, symbol: "ITBEES.NS", market: "india", analyst_score: 70, macro_score: null, availability_mask: { macro: false },
    } }];
    const factors: any[] = [
      { series_id: "nifty50_close", obs_date: "2026-06-09", value: 100, fetched_at: "2026-06-09T12:00:00.000Z" },
      { series_id: "nifty50_close", obs_date: "2026-06-10", value: 101, fetched_at: "2026-06-11T12:00:00.000Z" },
    ];
    const cells = buildMacroForwardEvidence("india", labels, factors);
    expect(cells.some((cell) => cell.series === "NIFTY 50 daily % change")).toBe(false);
  });

  it("withholds stale India factors instead of carrying them forward indefinitely", () => {
    const labels: any[] = [{ horizon_days: 2, benchmark_neutral_return: 0.02, decision_observations: {
      ts: "2026-06-10T13:00:00.000Z", symbol: "ITBEES.NS", market: "india", analyst_score: 70,
      macro_score: null, availability_mask: { macro: false },
    } }];
    const factors: any[] = [
      { series_id: "nifty50_close", obs_date: "2026-05-01", value: 100, fetched_at: "2026-05-01T12:00:00.000Z" },
      { series_id: "nifty50_close", obs_date: "2026-05-02", value: 101, fetched_at: "2026-05-02T12:00:00.000Z" },
    ];
    const cells = buildMacroForwardEvidence("india", labels, factors);
    expect(cells.some((cell) => cell.series === "NIFTY 50 daily % change")).toBe(false);
  });

  it("compares raw and exposure-oriented US macro against absolute returns for the fixed inverse/long set", () => {
    const labels: any[] = [];
    const symbols = ["SPY", "QQQ", "SOXX", "SOXL", "TQQQ", "SOXS", "SQQQ"];
    for (let i = 0; i < 30; i++) {
      const date = dateAfter("2026-01-01", i);
      const macro = 30 + i * 2;
      for (const symbol of symbols) {
        const inverse = symbol === "SOXS" || symbol === "SQQQ";
        labels.push({ horizon_days: 2, benchmark_neutral_return: 0.001, fwd_return: (inverse ? -1 : 1) * i / 100, decision_observations: {
          ts: `${date}T14:00:00.000Z`, symbol, market: "us", analyst_score: 60, macro_score: macro,
          availability_mask: { macro: true }, technical_as_of: date,
          formula_lineage: { versions: { macro: "macro_v1", composite: "composite_v1" } },
        } });
      }
    }

    const cells = buildMacroForwardEvidence("us", labels, []);
    const rawInverse = cells.find((cell) => cell.instrument === "SOXS" && cell.series === "us_macro_underlying_raw_v1");
    const orientedInverse = cells.find((cell) => cell.instrument === "SOXS" && cell.series === "us_macro_exposure_oriented_v1");
    const orientedLong = cells.find((cell) => cell.instrument === "SOXL" && cell.series === "us_macro_exposure_oriented_v1");

    expect(rawInverse?.returnBasis).toBe("absolute_instrument");
    expect(rawInverse?.spearmanIc).toBeCloseTo(-1, 10);
    expect(orientedInverse?.spearmanIc).toBeCloseTo(1, 10);
    expect(orientedLong?.spearmanIc).toBeCloseTo(1, 10);
    expect(orientedInverse?.formulaVersion).toBe("us_macro_exposure_direction_v1_20261028");
  });

  it("uses the frozen price-bar session and keeps per-instrument outcomes when benchmark marks are missing", () => {
    const cells = buildMacroForwardEvidence("us", [{
      horizon_days: 2, benchmark_neutral_return: null, fwd_return: 0.08,
      decision_observations: {
        ts: "2026-10-24T14:00:00.000Z", technical_as_of: "2026-10-23", symbol: "SOXL", market: "us",
        macro_score: 70, analyst_score: 60, availability_mask: { macro: true },
      },
    }], []);
    const cell = cells.find((item) => item.instrument === "SOXL" && item.returnBasis === "absolute_instrument");
    expect(cell?.matchedDates).toBe(1);
    expect(cell?.symbolRows).toBe(1);
    expect(cell?.state).toBe("insufficient");
    expect(cells.every((item) => item.returnBasis === "absolute_instrument")).toBe(true);
  });
});
