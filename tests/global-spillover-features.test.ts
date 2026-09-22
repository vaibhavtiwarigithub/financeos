import { describe, it, expect } from "vitest";
import { latestSessionChangePct } from "@/lib/trading/global-spillover-features";
import type { Candle } from "@/lib/data/technicals";

function c(date: string, close: number): Candle {
  return { date, close, high: close, low: close, open: close, volume: 1 };
}

describe("latestSessionChangePct", () => {
  it("returns null for fewer than 2 candles", () => {
    expect(latestSessionChangePct([])).toBeNull();
    expect(latestSessionChangePct([c("2026-01-01", 100)])).toBeNull();
  });

  it("computes a positive change correctly", () => {
    const out = latestSessionChangePct([c("2026-01-01", 100), c("2026-01-02", 103)]);
    expect(out).not.toBeNull();
    expect(out!.changePct).toBeCloseTo(3, 6);
    expect(out!.sessionDate).toBe("2026-01-02");
    expect(out!.priorDate).toBe("2026-01-01");
  });

  it("computes a negative change correctly", () => {
    const out = latestSessionChangePct([c("2026-01-01", 100), c("2026-01-02", 97)]);
    expect(out!.changePct).toBeCloseTo(-3, 6);
  });

  it("ignores trailing non-positive or malformed candles", () => {
    const out = latestSessionChangePct([c("2026-01-01", 100), c("2026-01-02", 110), c("2026-01-03", 0)]);
    expect(out!.changePct).toBeCloseTo(10, 6); // uses the last VALID pair, not the zero bar
  });

  it("returns null when the prior close is non-positive", () => {
    expect(latestSessionChangePct([c("2026-01-01", -5), c("2026-01-02", 100)])).toBeNull();
  });
});
