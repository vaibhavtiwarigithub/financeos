import { describe, expect, it } from "vitest";
import { buildPropertyBaselineForecast } from "@/lib/property/forecast";

describe("property baseline forecast", () => {
  it("builds an ordered uncertainty interval from enough observations", () => {
    const points = Array.from({ length: 8 }, (_, i) => ({ asOf: `202${i}-01-01`, value: 100 + i * 3 }));
    const result = buildPropertyBaselineForecast(points);
    expect(result).not.toBeNull(); expect(result!.lower).toBeLessThanOrEqual(result!.base); expect(result!.upper).toBeGreaterThanOrEqual(result!.base);
  });
  it("abstains on insufficient or invalid data", () => {
    expect(buildPropertyBaselineForecast([{ asOf: "2026-01-01", value: 100 }])).toBeNull();
    expect(buildPropertyBaselineForecast(Array.from({ length: 7 }, (_, i) => ({ asOf: `202${i}-01-01`, value: Number.NaN })))).toBeNull();
  });
});
