import { describe, it, expect } from "vitest";
import {
  MATERIAL_MOVE_PCT,
  dayChangePct,
  computePeerMoves,
  materialPeerMoves,
} from "@/lib/data/peer-moves";

describe("dayChangePct", () => {
  it("computes (close-open)/open*100", () => {
    expect(dayChangePct(100, 104)).toBeCloseTo(4);
    expect(dayChangePct(100, 95.9)).toBeCloseTo(-4.1);
  });

  it("returns null for unusable inputs", () => {
    expect(dayChangePct(0, 10)).toBeNull();
    expect(dayChangePct(-5, 10)).toBeNull();
    expect(dayChangePct(null, 10)).toBeNull();
    expect(dayChangePct(10, undefined)).toBeNull();
    expect(dayChangePct(Number.NaN, 10)).toBeNull();
  });
});

describe("computePeerMoves", () => {
  it("marks moves >= 3% (either direction) material and rounds to 1 decimal", () => {
    const moves = computePeerMoves(["AMD", "AVGO", "MU"], {
      AMD: -4.12,
      AVGO: 3.24,
      MU: 1.1,
    });
    expect(moves).toEqual([
      { symbol: "AMD", changePct: -4.1, material: true },
      { symbol: "AVGO", changePct: 3.2, material: true },
      { symbol: "MU", changePct: 1.1, material: false },
    ]);
  });

  it("uses MATERIAL_MOVE_PCT as the threshold on the rounded value", () => {
    expect(MATERIAL_MOVE_PCT).toBe(3);
    // 2.96 rounds to 3.0 → material; 2.94 rounds to 2.9 → not.
    const moves = computePeerMoves(["A", "B"], { A: 2.96, B: 2.94 });
    expect(moves.find((m) => m.symbol === "A")?.material).toBe(true);
    expect(moves.find((m) => m.symbol === "B")?.material).toBe(false);
  });

  it("orders material first, then by magnitude desc, then alphabetically", () => {
    const moves = computePeerMoves(["X", "Y", "Z", "W"], {
      X: 1.0, // non-material
      Y: 3.5, // material
      Z: -5.0, // material, biggest
      W: -3.5, // material, ties with Y on magnitude → alpha
    });
    expect(moves.map((m) => m.symbol)).toEqual(["Z", "W", "Y", "X"]);
  });

  it("drops peers with no day-change data", () => {
    const moves = computePeerMoves(["AMD", "GHOST"], { AMD: 4 });
    expect(moves.map((m) => m.symbol)).toEqual(["AMD"]);
  });

  it("de-duplicates and normalizes case/whitespace", () => {
    const moves = computePeerMoves([" amd ", "AMD", "AmD"], { AMD: 4 });
    expect(moves).toHaveLength(1);
    expect(moves[0].symbol).toBe("AMD");
  });

  it("accepts a Map as well as a plain object", () => {
    const moves = computePeerMoves(["AMD"], new Map([["AMD", 4]]));
    expect(moves[0]).toEqual({ symbol: "AMD", changePct: 4, material: true });
  });

  it("handles empty / null peers gracefully (India case)", () => {
    expect(computePeerMoves([], { AMD: 4 })).toEqual([]);
    expect(computePeerMoves(null, { AMD: 4 })).toEqual([]);
    expect(computePeerMoves(undefined, {})).toEqual([]);
  });

  it("ignores non-finite change values", () => {
    const moves = computePeerMoves(["AMD"], { AMD: Number.NaN });
    expect(moves).toEqual([]);
  });
});

describe("materialPeerMoves", () => {
  it("returns only material movers", () => {
    const moves = materialPeerMoves(["AMD", "AVGO", "MU"], {
      AMD: -4.1,
      AVGO: 3.2,
      MU: 1.1,
    });
    expect(moves.map((m) => m.symbol)).toEqual(["AMD", "AVGO"]);
    expect(moves.every((m) => m.material)).toBe(true);
  });
});
