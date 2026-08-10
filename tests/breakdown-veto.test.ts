// Test 16 (fix-prompt §Required tests): the parabolic / high-volume reversal
// regression. Before the fix, a -12% high-volume down-bar whose RSI had decayed
// back into the "preferred" band and whose price still sat just above EMA20
// scored ~100 — momentum math read heavy SELL volume as bullish confirmation.
// The deterministic breakdown veto now hard-caps such a setup at 20 BEFORE any
// momentum scoring runs.

import { describe, it, expect } from "vitest";
import { scoreTechnicals, detectBreakdownVeto, type TechnicalResult } from "@/lib/data/technicals";

// A setup that momentum math WOULD score highly: RSI in band, above both EMAs,
// uptrend, elevated volume. The last-bar diagnostics decide whether it's real
// strength or a reversal wearing a bullish mask.
function t(over: Partial<TechnicalResult>): TechnicalResult {
  return {
    rsi14: 62, ema20: 100, ema50: 98,
    priceVsEma20: "above", priceVsEma50: "above",
    volumeVsAvg20: 1.0, trend20d: "up", dataPoints: 60,
    atr14: 2, lastReturnPct: 0.5, lastRangeLocation: 0.8, atrMultipleMove: 0.25,
    ema200: null, macdLine: null, macdSignal: null, macdHistogram: null, adx14: null, rsVsSpy: null,
    ...over,
  };
}

describe("detectBreakdownVeto", () => {
  it("fires on a volatility-adjusted crash (down bar >= 2.5 ATRs)", () => {
    const v = detectBreakdownVeto(t({ lastReturnPct: -12, atrMultipleMove: 3.0 }));
    expect(v.vetoed).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/Volatility-adjusted crash/);
  });

  it("fires on a high-volume breakdown (<= -7% on >= 1.5x volume)", () => {
    const v = detectBreakdownVeto(t({ lastReturnPct: -8, volumeVsAvg20: 2.0, atrMultipleMove: 1.0 }));
    expect(v.vetoed).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/High-volume breakdown/);
  });

  it("records but does not veto a weak bottom-quartile close after an ordinary down day", () => {
    const v = detectBreakdownVeto(t({ lastReturnPct: -1.5, lastRangeLocation: 0.1, atrMultipleMove: 0.5 }));
    expect(v.vetoed).toBe(false);
    expect(v.warnings.join(" ")).toMatch(/Weak close/);
  });

  it("does NOT fire on a genuine up-bar with a strong close", () => {
    expect(detectBreakdownVeto(t({ lastReturnPct: 1.2, lastRangeLocation: 0.9, atrMultipleMove: 0.6 })).vetoed).toBe(false);
  });

  it("does NOT fire when last-bar diagnostics are unavailable (fails open, no false veto)", () => {
    expect(detectBreakdownVeto(t({ lastReturnPct: null, atrMultipleMove: null, lastRangeLocation: null })).vetoed).toBe(false);
  });
});

describe("scoreTechnicals — breakdown veto caps the score (regression)", () => {
  it("caps a -12% high-volume reversal at 20 despite bullish-looking momentum", () => {
    // This is the exact false-positive: RSI 62, above EMAs, uptrend, high volume,
    // but a -12% bar that fell 3 ATRs and closed near the low.
    const reversal = t({ lastReturnPct: -12, atrMultipleMove: 3.0, volumeVsAvg20: 2.2, lastRangeLocation: 0.1 });
    expect(scoreTechnicals(reversal)).toBeLessThanOrEqual(20);
  });

  it("a clean momentum setup with the same RSI/EMA context still scores well above the veto cap", () => {
    const clean = t({ lastReturnPct: 1.0, atrMultipleMove: 0.5, volumeVsAvg20: 1.3, lastRangeLocation: 0.85 });
    expect(scoreTechnicals(clean)).toBeGreaterThan(60);
  });

  it("the veto runs BEFORE momentum math — a maxed-out momentum setup is still capped", () => {
    const rigged = t({ rsi14: 68, trend20d: "up", volumeVsAvg20: 3, lastReturnPct: -9, atrMultipleMove: 2.8, lastRangeLocation: 0.05 });
    expect(scoreTechnicals(rigged)).toBe(20);
  });
});
