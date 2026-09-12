import { describe, expect, it } from "vitest";
import { simulateExitLadderPath } from "./exit-ladder-sim";

const entry = { date: "2026-01-01", high: 100, low: 100, close: 100 };

describe("simulateExitLadderPath", () => {
  it("banks half at the close target and lets the runner continue", () => {
    const result = simulateExitLadderPath([
      entry,
      { date: "2026-01-02", high: 110, low: 105, close: 110 },
      { date: "2026-01-03", high: 125, low: 112, close: 120 },
    ], { market: "us", qty: 10, stopPct: 0.07, targetPct: 0.08, maxSessions: 2, useSessionLow: true });
    expect(result.partialTaken).toBe(true);
    expect(result.finalReason).toBe("mark");
    expect(result.ret).toBeCloseTo(0.15, 8);
  });

  it("computes today's stop from the prior high, then ratchets for tomorrow", () => {
    const result = simulateExitLadderPath([
      entry,
      { date: "2026-01-02", high: 121, low: 94, close: 120 },
      { date: "2026-01-03", high: 113, low: 110, close: 112 },
    ], { market: "us", qty: 10, stopPct: 0.07, maxSessions: 2, useSessionLow: true });
    expect(result.finalReason).toBe("stop");
    expect(result.sessions).toBe(2);
    expect(result.ret).toBeCloseTo(0.116, 8);
  });

  it("uses close-only stop evidence when session lows are unavailable", () => {
    const bars = [entry, { date: "2026-01-02", high: 105, low: 90, close: 101 }];
    const closeOnly = simulateExitLadderPath(bars, {
      market: "india", qty: 10, stopPct: 0.07, maxSessions: 1, useSessionLow: false,
    });
    const withLow = simulateExitLadderPath(bars, {
      market: "us", qty: 10, stopPct: 0.07, maxSessions: 1, useSessionLow: true,
    });
    expect(closeOnly.finalReason).toBe("mark");
    expect(withLow.finalReason).toBe("stop");
  });
});
