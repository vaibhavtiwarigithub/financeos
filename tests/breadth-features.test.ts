import { describe, it, expect } from "vitest";
import { computeBreadthAboveSma50 } from "@/lib/trading/breadth-features";
import type { Candle } from "@/lib/data/technicals";

function series(closes: number[]): Candle[] {
  return closes.map((close, i) => ({ date: `d${i}`, close, high: close, low: close, open: close, volume: 1 }));
}

describe("computeBreadthAboveSma50", () => {
  it("returns null pct and zero coverage for an empty universe", () => {
    const out = computeBreadthAboveSma50(new Map());
    expect(out).toEqual({ pctAboveSma50: null, eligible: 0, resolved: 0, universeSize: 0, coveragePct: 0 });
  });

  it("excludes a symbol with fewer than 50 candles from eligible", () => {
    const map = new Map([["A", series(Array.from({ length: 30 }, (_, i) => 100 + i))]]);
    const out = computeBreadthAboveSma50(map);
    expect(out.eligible).toBe(0);
    expect(out.pctAboveSma50).toBeNull();
    expect(out.universeSize).toBe(1);
    expect(out.coveragePct).toBe(0);
  });

  it("counts a symbol trending up as above its SMA50", () => {
    // Flat 99 for 49 bars then a jump — last close is above the 50-bar average.
    const closes = [...Array(49).fill(99), 150];
    const map = new Map([["UP", series(closes)]]);
    const out = computeBreadthAboveSma50(map);
    expect(out.eligible).toBe(1);
    expect(out.resolved).toBe(1);
    expect(out.pctAboveSma50).toBe(100);
  });

  it("counts a symbol trending down as below its SMA50", () => {
    const closes = [...Array(49).fill(101), 50];
    const map = new Map([["DOWN", series(closes)]]);
    const out = computeBreadthAboveSma50(map);
    expect(out.resolved).toBe(0);
    expect(out.pctAboveSma50).toBe(0);
  });

  it("computes a real mixed-universe percentage and coverage", () => {
    const up = series([...Array(49).fill(99), 150]);
    const down = series([...Array(49).fill(101), 50]);
    const tooShort = series(Array.from({ length: 10 }, (_, i) => 100 + i));
    const map = new Map([["UP", up], ["DOWN", down], ["SHORT", tooShort]]);
    const out = computeBreadthAboveSma50(map);
    expect(out.universeSize).toBe(3);
    expect(out.eligible).toBe(2);
    expect(out.resolved).toBe(1);
    expect(out.pctAboveSma50).toBe(50);
    expect(out.coveragePct).toBeCloseTo(66.67, 1);
  });

  it("ignores non-positive closes when finding the latest price", () => {
    const closes = [...Array(49).fill(100), 0];
    const map = new Map([["BAD", series(closes)]]);
    const out = computeBreadthAboveSma50(map);
    // The trailing 0 is filtered out entirely, so only 49 valid closes remain
    // (below the 50 threshold) -- never treated as a real "below SMA" close.
    expect(out.eligible).toBe(0);
  });
});
