import { describe, expect, it } from "vitest";
import {
  buildPropertyBaselineForecast,
  inferPeriodsForward,
  selectForecastObservationWindow,
} from "@/lib/property/forecast";

describe("property baseline forecast", () => {
  it("builds an ordered uncertainty interval from enough observations", () => {
    const points = Array.from({ length: 8 }, (_, i) => ({ asOf: `202${i}-01-01`, value: 100 + i * 3 }));
    const result = buildPropertyBaselineForecast(points);
    expect(result).not.toBeNull(); expect(result!.lower).toBeLessThanOrEqual(result!.base); expect(result!.upper).toBeGreaterThanOrEqual(result!.base);
  });
  it("compounds drift across the inferred forecast horizon", () => {
    const points = Array.from({ length: 8 }, (_, i) => ({
      asOf: `${2020 + i}-03-31`,
      value: 100 * 1.1 ** i,
    }));
    const result = buildPropertyBaselineForecast(points, 4);
    expect(result?.method).toBe("drift_uncertainty_v2");
    expect(result?.base).toBeCloseTo(points[7].value * 1.1 ** 4, 8);
  });
  it("abstains on insufficient or invalid data", () => {
    expect(buildPropertyBaselineForecast([{ asOf: "2026-01-01", value: 100 }])).toBeNull();
    expect(buildPropertyBaselineForecast(Array.from({ length: 7 }, (_, i) => ({ asOf: `202${i}-01-01`, value: Number.NaN })))).toBeNull();
  });
});

describe("property forecast data selection", () => {
  it("takes the newest bounded window and returns it chronologically", () => {
    const rows = Array.from({ length: 140 }, (_, index) => {
      const date = new Date(Date.UTC(2000, index, 1)).toISOString().slice(0, 10);
      return { sourceKey: "source-a", asOf: date, value: index + 1, collectedAt: `${date}T12:00:00Z`, revisionState: "initial" as const };
    });
    const selected = selectForecastObservationWindow(rows, 100)!;
    expect(selected.points).toHaveLength(100);
    expect(selected.points[0].value).toBe(41);
    expect(selected.points[99].value).toBe(140);
  });

  it("uses one coherent source and prefers the source with the freshest endpoint", () => {
    const selected = selectForecastObservationWindow([
      ...Array.from({ length: 20 }, (_, index) => ({ sourceKey: "stale-long", asOf: `${2000 + index}-01-01`, value: 100 + index, collectedAt: `${2000 + index}-02-01T00:00:00Z`, revisionState: "initial" as const })),
      ...Array.from({ length: 8 }, (_, index) => ({ sourceKey: "fresh", asOf: `${2019 + index}-06-30`, value: 200 + index, collectedAt: `${2019 + index}-07-01T00:00:00Z`, revisionState: "initial" as const })),
    ])!;
    expect(selected.sourceKey).toBe("fresh");
    expect(selected.points.every((point) => point.value >= 200)).toBe(true);
  });

  it("collapses same-date revisions to the latest collected value", () => {
    const selected = selectForecastObservationWindow([
      { sourceKey: "fhfa", asOf: "2026-03-31", value: 100, collectedAt: "2026-04-01T00:00:00Z", revisionState: "initial" },
      { sourceKey: "fhfa", asOf: "2026-03-31", value: 103, collectedAt: "2026-05-01T00:00:00Z", revisionState: "revised" },
    ])!;
    expect(selected.points).toEqual([{ asOf: "2026-03-31", value: 103 }]);
  });

  it("maps declared day horizons to observed weekly and quarterly periods", () => {
    const weekly = Array.from({ length: 20 }, (_, index) => ({ asOf: new Date(Date.UTC(2026, 0, 1 + index * 7)).toISOString().slice(0, 10), value: 6 }));
    const quarterly = Array.from({ length: 8 }, (_, index) => ({ asOf: new Date(Date.UTC(2024, index * 3, 1)).toISOString().slice(0, 10), value: 100 }));
    expect(inferPeriodsForward(weekly, 90)).toBe(13);
    expect(inferPeriodsForward(quarterly, 365)).toBe(4);
  });
});
