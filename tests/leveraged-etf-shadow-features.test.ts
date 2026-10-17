import { describe, it, expect } from "vitest";
import { computeLeveragedPathFeatures, computeLeveragedShadowFeatures } from "@/lib/trading/leveraged-etf-shadow-features";
import type { Candle } from "@/lib/data/technicals";

function candle(date: string, close: number, opts: Partial<Candle> = {}): Candle {
  return { date, close, high: opts.high ?? close * 1.01, low: opts.low ?? close * 0.99, open: opts.open ?? close, volume: opts.volume ?? 1_000_000 };
}

describe("computeLeveragedShadowFeatures", () => {
  it("returns all-null for empty input", () => {
    const out = computeLeveragedShadowFeatures([]);
    expect(out).toEqual({ realizedVol20dPct: null, atr14Pct: null, trend20dPct: null, dollarVolume: null });
  });

  it("returns all-null (except dollar volume) for too few candles", () => {
    const candles = Array.from({ length: 10 }, (_, i) => candle(`2026-01-${String(i + 1).padStart(2, "0")}`, 100 + i));
    const out = computeLeveragedShadowFeatures(candles);
    expect(out.trend20dPct).toBeNull();
    expect(out.realizedVol20dPct).toBeNull();
    expect(out.atr14Pct).toBeNull();
    expect(out.dollarVolume).toBe(candles[candles.length - 1].close * 1_000_000);
  });

  it("computes trend20dPct as close[-1] vs close[-21]", () => {
    const candles = Array.from({ length: 21 }, (_, i) => candle(`d${i}`, 100));
    candles[candles.length - 1] = candle("last", 110);
    const out = computeLeveragedShadowFeatures(candles);
    expect(out.trend20dPct).toBeCloseTo(10, 5); // (110-100)/100 * 100
  });

  it("computes zero realized vol for a flat price series", () => {
    const candles = Array.from({ length: 25 }, (_, i) => candle(`d${i}`, 100));
    const out = computeLeveragedShadowFeatures(candles);
    expect(out.realizedVol20dPct).toBeCloseTo(0, 5);
  });

  it("computes a positive ATR14 pct for a series with real ranges", () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      candle(`d${i}`, 100 + i, { high: 100 + i + 2, low: 100 + i - 2 }));
    const out = computeLeveragedShadowFeatures(candles);
    expect(out.atr14Pct).not.toBeNull();
    expect(out.atr14Pct!).toBeGreaterThan(0);
  });

  it("ignores non-positive closes without throwing", () => {
    const candles = [candle("a", 0), candle("b", -5), candle("c", 100)];
    const out = computeLeveragedShadowFeatures(candles);
    expect(out.dollarVolume).toBe(100 * 1_000_000);
  });

  it("handles missing/non-finite volume on the latest bar", () => {
    const candles = [candle("a", 100, { volume: NaN })];
    const out = computeLeveragedShadowFeatures(candles);
    expect(out.dollarVolume).toBeNull();
  });
});

describe("leveraged ETF path-risk proxy measurements", () => {
  it("measures the inverse leg against -3x daily underlying returns, not stock fundamentals", () => {
    const underlying = Array.from({ length: 21 }, (_, i) => candle(`d${i}`, 100 * 0.99 ** i));
    const inverse = Array.from({ length: 21 }, (_, i) => candle(`d${i}`, 100 * 1.03 ** i));
    const same = computeLeveragedPathFeatures(inverse, underlying, "inverse");
    const wrongSide = computeLeveragedPathFeatures(inverse, underlying, "long");
    expect(same.proxyTrackingRms20dPct).toBeCloseTo(0, 8);
    expect(wrongSide.proxyTrackingRms20dPct).toBeGreaterThan(5);
  });
  it("does not fill missing aligned sessions or missing opens with a zero-risk value", () => {
    const under = Array.from({ length: 21 }, (_, i) => candle(`d${i}`, 100));
    const etf = under.slice(1).map(c => candle(c.date, 100, { open: Number.NaN }));
    const result = computeLeveragedPathFeatures(etf, under, "long");
    expect(result.proxyTrackingRms20dPct).toBeNull();
    expect(result.maxAbsOvernightGap20dPct).toBeNull();
  });
  it("refuses proxy tracking when an interior proxy session is absent", () => {
    const etf = Array.from({ length: 21 }, (_, i) => candle(`d${i}`, 100));
    const proxy = etf.filter(c => c.date !== "d10");
    expect(computeLeveragedPathFeatures(etf, proxy, "long").proxyTrackingRms20dPct).toBeNull();
  });
});
