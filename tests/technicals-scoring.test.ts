import { describe, it, expect } from "vitest";
import { scoreTechnicals, type TechnicalResult } from "@/lib/data/technicals";

function t(over: Partial<TechnicalResult>): TechnicalResult {
  return {
    rsi14: 50, ema20: 100, ema50: 100,
    priceVsEma20: "above", priceVsEma50: "above",
    volumeVsAvg20: 1.0, trend20d: "flat", dataPoints: 60,
    atr14: null, lastReturnPct: null, lastRangeLocation: null, atrMultipleMove: null,
    ...over,
  };
}

describe("scoreTechnicals", () => {
  it("returns neutral 50 with insufficient data (<15 candles)", () => {
    expect(scoreTechnicals(t({ dataPoints: 10 }))).toBe(50);
  });

  it("momentum peak (RSI ~65, above EMAs, uptrend) scores well above a weak setup", () => {
    const strong = scoreTechnicals(t({ rsi14: 65, trend20d: "up" }));
    const weak = scoreTechnicals(t({ rsi14: 45, priceVsEma20: "below", priceVsEma50: "below", trend20d: "down" }));
    expect(strong).toBeGreaterThan(weak + 30);
  });

  it("RSI is CONTINUOUS — no cliff across the old 59/60 bucket edge", () => {
    const at59 = scoreTechnicals(t({ rsi14: 59 }));
    const at60 = scoreTechnicals(t({ rsi14: 60 }));
    expect(Math.abs(at60 - at59)).toBeLessThanOrEqual(4); // old bucketed code jumped ~13
  });

  it("volume CONFIRMS direction (elevated volume adds vs flat volume, with headroom below the cap)", () => {
    // Mild setup (well below the 100 ceiling) so the volume delta is visible:
    // above EMA20 (bullish context) but below EMA50, neutral RSI/trend.
    const base = { rsi14: 48, priceVsEma20: "above" as const, priceVsEma50: "below" as const, trend20d: "flat" as const };
    const highVol = scoreTechnicals(t({ ...base, volumeVsAvg20: 1.6 }));
    const normalVol = scoreTechnicals(t({ ...base, volumeVsAvg20: 1.0 }));
    expect(highVol).toBeGreaterThan(normalVol);
  });

  it("clamps to 0..100", () => {
    const s = scoreTechnicals(t({ rsi14: 68, trend20d: "up", volumeVsAvg20: 2 }));
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });
});
