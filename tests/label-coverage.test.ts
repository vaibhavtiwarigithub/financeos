import { describe, it, expect } from "vitest";
import {
  bindingCoverage,
  coverageBlockers,
  coverageByHorizon,
  MIN_DISTINCT_DATES,
  type LabelRow,
} from "@/lib/shadows/label-coverage";

function rows(spec: Array<[string, string, number, boolean?]>): LabelRow[] {
  return spec.map(([date, symbol, horizonDays, entryEligible]) => ({
    date, symbol, horizonDays, entryEligible: entryEligible ?? true,
  }));
}

/** The real 2026-08-06 US watchlist cohort: 10 semis, 3 days, none eligible. */
const WATCHLIST_ARTEFACT: LabelRow[] = ["2026-07-09", "2026-07-10", "2026-07-13"].flatMap((date) =>
  ["SOXL", "MRVL", "ARM", "MU", "INTC", "QCOM", "TSM", "AVGO", "NVDA"].map((symbol) => ({
    date, symbol, horizonDays: 5, entryEligible: false,
  })),
);

describe("coverageByHorizon — n is not the sample size", () => {
  it("separates observation count from distinct dates", () => {
    const c = coverageByHorizon(WATCHLIST_ARTEFACT)[0];
    expect(c.observations).toBe(27);
    expect(c.distinctDates).toBe(3);
    expect(c.distinctSymbols).toBe(9);
    expect(c.observationsPerDate).toBe(9);
    expect(c.sufficient).toBe(false);
  });

  it("groups per horizon and sorts ascending", () => {
    const c = coverageByHorizon(rows([
      ["2026-07-06", "AAPL", 10], ["2026-07-06", "AAPL", 2], ["2026-07-07", "MSFT", 2],
    ]));
    expect(c.map((x) => x.horizonDays)).toEqual([2, 10]);
    expect(c[0].observations).toBe(2);
    expect(c[1].observations).toBe(1);
  });

  it("reaches sufficiency only at the date floor, not the observation count", () => {
    // 100 observations on 4 dates is NOT sufficient...
    const many = coverageByHorizon(rows(
      Array.from({ length: 100 }, (_, i) => [`2026-07-0${(i % 4) + 1}`, `S${i}`, 10] as [string, string, number]),
    ))[0];
    expect(many.observations).toBe(100);
    expect(many.sufficient).toBe(false);

    // ...while 20 observations on 20 dates is.
    const spread = coverageByHorizon(rows(
      Array.from({ length: MIN_DISTINCT_DATES }, (_, i) => [`2026-07-${String(i + 1).padStart(2, "0")}`, "AAPL", 10] as [string, string, number]),
    ))[0];
    expect(spread.observations).toBe(MIN_DISTINCT_DATES);
    expect(spread.sufficient).toBe(true);
  });
});

describe("bindingCoverage — the traded horizon binds", () => {
  it("prefers the 10-day horizon even when shorter ones look healthier", () => {
    const c = coverageByHorizon([
      ...rows(Array.from({ length: 30 }, (_, i) => [`2026-07-${String(i + 1).padStart(2, "0")}`, "AAPL", 2] as [string, string, number])),
      ...rows([["2026-07-06", "AAPL", 10], ["2026-07-07", "AAPL", 10]]),
    ]);
    const binding = bindingCoverage(c)!;
    expect(binding.horizonDays).toBe(10);
    expect(binding.sufficient).toBe(false); // a healthy 2d cohort must not mask this
  });

  it("falls back to the longest horizon below 10 when 10 is absent", () => {
    expect(bindingCoverage(coverageByHorizon(rows([
      ["2026-07-06", "AAPL", 2], ["2026-07-06", "AAPL", 5],
    ])))!.horizonDays).toBe(5);
  });

  it("returns null on an empty set", () => {
    expect(bindingCoverage([])).toBeNull();
  });
});

describe("coverageBlockers", () => {
  it("names the date shortfall, the repetition, and the zero-eligible trap", () => {
    const blockers = coverageBlockers(coverageByHorizon(WATCHLIST_ARTEFACT));
    expect(blockers).toHaveLength(3);
    expect(blockers[0]).toContain("3 distinct decision date");
    expect(blockers[1]).toContain("overstates the independent sample");
    // The mistake that made the original diagnosis wrong: a cohort that never
    // passed the eligibility gate cannot explain realised P&L.
    expect(blockers[2]).toContain("entry-eligible");
  });

  it("clears when the binding horizon has enough spread-out dates", () => {
    const spread = rows(Array.from({ length: MIN_DISTINCT_DATES }, (_, i) =>
      [`2026-07-${String(i + 1).padStart(2, "0")}`, "AAPL", 10] as [string, string, number]));
    expect(coverageBlockers(coverageByHorizon(spread))).toEqual([]);
  });

  it("reports absence rather than passing on no data", () => {
    expect(coverageBlockers([])).toEqual(["No matured decision labels exist for this market."]);
  });
});
