import { describe, it, expect } from "vitest";
import { computeRegimeFeatures } from "@/lib/validation/regime";

function flatSeries(n: number, price = 100): number[] {
  return new Array(n).fill(price);
}

describe("computeRegimeFeatures", () => {
  it("returns nulls when fewer than 200 closes are available (no 200d MA)", () => {
    const result = computeRegimeFeatures(flatSeries(100));
    expect(result.trend).toBeNull();
  });

  it("returns trend 0 for a perfectly flat series (ma50 == ma200)", () => {
    const result = computeRegimeFeatures(flatSeries(250));
    expect(result.trend).toBeCloseTo(0, 5);
  });

  it("returns a positive trend when recent prices are higher (uptrend)", () => {
    // 200 flat at 100, then 50 rising — ma50 > ma200
    const closes = [...flatSeries(200, 100), ...Array.from({ length: 50 }, (_, i) => 100 + i)];
    const result = computeRegimeFeatures(closes);
    expect(result.trend).toBeGreaterThan(0);
  });

  it("returns null realizedVol with fewer than 21 closes", () => {
    const result = computeRegimeFeatures(flatSeries(10));
    expect(result.realizedVol).toBeNull();
  });

  it("classifies a low-volatility flat series as the 'low' tercile", () => {
    const result = computeRegimeFeatures(flatSeries(250));
    expect(result.realizedVol).toBeCloseTo(0, 5);
    expect(result.volTercile).toBe("low");
  });

  it("classifies a high-volatility series as the 'high' tercile", () => {
    const volatile: number[] = [];
    let price = 100;
    for (let i = 0; i < 250; i++) { price *= i % 2 === 0 ? 1.05 : 0.95; volatile.push(price); }
    const result = computeRegimeFeatures(volatile);
    expect(result.volTercile).toBe("high");
  });
});
