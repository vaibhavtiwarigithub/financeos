import { describe, it, expect } from "vitest";
import { kellyFraction, positionSizePct } from "@/lib/risk/sizing";

describe("kellyFraction", () => {
  it("returns 0 for a coin-flip with 1:1 payoff (no edge)", () => {
    expect(kellyFraction(0.5, 1)).toBeCloseTo(0, 5);
  });

  it("returns a positive fraction when edge is positive", () => {
    // p=0.6, b=2 -> (0.6*2 - 0.4)/2 = 0.4
    expect(kellyFraction(0.6, 2)).toBeCloseTo(0.4, 5);
  });

  it("returns a negative fraction when there is no edge (caller should not bet)", () => {
    expect(kellyFraction(0.3, 1)).toBeLessThan(0);
  });

  it("returns 0 for invalid inputs (bad payoff or out-of-range probability)", () => {
    expect(kellyFraction(0.5, 0)).toBe(0);
    expect(kellyFraction(0.5, -1)).toBe(0);
    expect(kellyFraction(1.5, 2)).toBe(0);
    expect(kellyFraction(-0.1, 2)).toBe(0);
  });
});

describe("positionSizePct (never exceeds cap, never negative, degrades to flat floor)", () => {
  it("never exceeds the half-Kelly cap even with a huge edge", () => {
    const size = positionSizePct(0.95, 10, { halfKellyCap: 0.10, floorPct: 0.02 });
    expect(size).toBeLessThanOrEqual(0.10);
  });

  it("never goes negative or below the floor when there is no edge", () => {
    const size = positionSizePct(0.3, 1, { halfKellyCap: 0.10, floorPct: 0.02 });
    expect(size).toBeGreaterThanOrEqual(0.02);
  });

  it("uses half of full Kelly, not full Kelly (ruin-risk guard)", () => {
    const full = kellyFraction(0.6, 2); // 0.4
    const sized = positionSizePct(0.6, 2, { halfKellyCap: 1, floorPct: 0 });
    expect(sized).toBeCloseTo(full * 0.5, 5);
  });

  it("degrades to the floor (flat minimum) when no calibrated edge exists", () => {
    const size = positionSizePct(0.5, 1);
    expect(size).toBe(0.02); // default floorPct
  });
});
