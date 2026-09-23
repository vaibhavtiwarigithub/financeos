import { describe, expect, it } from "vitest";
import { buildLeveragedEtfShadowObservation, isLeveragedObservationWindow } from "@/lib/trading/leveraged-etf-shadow";

const input = {
  observedAt: "2026-09-14T15:05:00.000Z", symbol: "TQQQ", etfPrice: 100, underlyingPrice: 600,
  bid: 99.9, ask: 100.1, quoteAsOf: "2026-09-14T15:04:58.000Z", underlyingQuoteAsOf: "2026-09-14T15:04:58.000Z",
  realizedVol20dPct: 2.1, atr14Pct: 3.2, trend20dPct: 4, underlyingTrend20dPct: 1.4, dollarVolume: 2_000_000,
};

describe("leveraged ETF L1 shadow", () => {
  it("keeps missing features missing instead of recording zero volatility", () => {
    const observation = buildLeveragedEtfShadowObservation({ ...input, realizedVol20dPct: null, atr14Pct: null });
    expect(observation.measurementStatus).toBe("incomplete");
    expect(observation.features.realized_vol_20d_pct).toBeNull();
    expect(observation.features.atr14_pct).toBeNull();
    expect(observation.missing).toEqual(expect.arrayContaining(["realized_vol_20d_pct", "atr14_pct"]));
  });
  it("permits measurement only for the explicit shadow universe", () => {
    expect(buildLeveragedEtfShadowObservation(input).decision).toBe("observe_only");
    expect(() => buildLeveragedEtfShadowObservation({ ...input, symbol: "AAPL" })).toThrow(/leveraged shadow/);
  });
  it("shadow-observes SQQQ/SOXS (inverse) but only ever produces observe_only — no trade door exists for them", () => {
    const sqqq = buildLeveragedEtfShadowObservation({ ...input, symbol: "SQQQ" });
    expect(sqqq.decision).toBe("observe_only");
    const soxs = buildLeveragedEtfShadowObservation({ ...input, symbol: "SOXS", underlyingPrice: 200 });
    expect(soxs.decision).toBe("observe_only");
    expect(soxs.underlyingSymbol).toBe("SOXX");
  });
  it("uses America/New_York, not a fixed UTC hour", () => {
    expect(isLeveragedObservationWindow("2026-09-14T15:05:00.000Z")).toBe(true);
    expect(isLeveragedObservationWindow("2026-12-14T15:05:00.000Z")).toBe(false);
  });
  it("never turns missing market data into an entry", () => {
    const observation = buildLeveragedEtfShadowObservation({ ...input, bid: null });
    expect(observation.measurementStatus).toBe("incomplete");
    expect(observation.missing).toContain("bid");
    expect(observation.decision).toBe("observe_only");
  });
});
