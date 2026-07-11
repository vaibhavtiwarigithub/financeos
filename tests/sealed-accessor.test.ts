// P0 — the sealed-accessor leak test. This alone satisfies the spirit of Required
// Test 14: "point-in-time label/universe fixtures cannot access future records."
// The accessor THROWS (does not silently filter) on any record dated after asOf.

import { describe, it, expect } from "vitest";
import { SealedDataAccessor, FutureDataLeakError } from "@/lib/replay/sealed-accessor";
import type { ReplayPacketItem, SealedObservation } from "@/lib/replay/types";
import type { LabeledObservation } from "@/lib/learning/dataset";

function item(overrides: Partial<ReplayPacketItem>): ReplayPacketItem {
  return {
    itemType: "ohlcv",
    symbol: "MU",
    knowableAt: "2023-01-10",
    payload: { close: 60 },
    payloadHash: "h",
    ...overrides,
  };
}

function obs(id: number, ts: string): LabeledObservation {
  return {
    id, ts, market: "us", symbol: "MU",
    analyst_score: 60, fundamental_score: 60, technical_score: 60,
    sentiment_score: 60, macro_score: 60, insider_score: 60,
    direction: "long", entry_eligible: true, score_threshold: 60, availability_mask: null,
    horizon_days: 10, fwd_return: 0.01, benchmark_return: 0,
    benchmark_neutral_return: 0.01, max_adverse_excursion: -0.02, max_favorable_excursion: 0.03,
  };
}

describe("SealedDataAccessor — throws on future data (Test 14)", () => {
  it("returns items dated on/before as-of without throwing", () => {
    const acc = new SealedDataAccessor("2023-01-15", {
      items: [item({ knowableAt: "2023-01-10" }), item({ knowableAt: "2023-01-15" })],
    });
    expect(acc.prices()).toHaveLength(2);
  });

  it("THROWS FutureDataLeakError when a packet item is dated after as-of", () => {
    const acc = new SealedDataAccessor("2023-01-15", {
      items: [item({ knowableAt: "2023-01-10" }), item({ knowableAt: "2023-01-16" })],
    });
    expect(() => acc.prices()).toThrow(FutureDataLeakError);
  });

  it("does NOT silently filter the future item (throw, not drop)", () => {
    const acc = new SealedDataAccessor("2023-01-15", {
      items: [item({ knowableAt: "2023-02-01", symbol: "INTC" })],
    });
    // A filtering implementation would return []; the sealed accessor must throw.
    let threw = false;
    try {
      acc.allItems();
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(FutureDataLeakError);
      expect((e as FutureDataLeakError).knowableAt).toBe("2023-02-01");
      expect((e as FutureDataLeakError).asOf).toBe("2023-01-15");
    }
    expect(threw).toBe(true);
  });

  it("treats a timestamp later the SAME day as knowable (not a leak)", () => {
    const acc = new SealedDataAccessor("2023-01-15", {
      items: [item({ knowableAt: "2023-01-15T20:00:00Z" })],
    });
    expect(acc.prices()).toHaveLength(1);
  });

  it("throws on a future-stamped labeled observation feed", () => {
    const sealed: SealedObservation[] = [
      { knowableAt: "2023-01-10", observation: obs(1, "2023-01-01T00:00:00Z") },
      { knowableAt: "2023-02-20", observation: obs(2, "2023-02-10T00:00:00Z") }, // future
    ];
    const acc = new SealedDataAccessor("2023-01-15", { observations: sealed });
    expect(() => acc.sealedObservations()).toThrow(FutureDataLeakError);
  });

  it("has no network client — data can only enter via the constructor", () => {
    const acc = new SealedDataAccessor("2023-01-15", {});
    expect(acc.prices()).toEqual([]);
    expect(acc.sealedObservations()).toEqual([]);
    // No fetch/provider methods exist on the accessor surface.
    expect((acc as unknown as Record<string, unknown>).fetch).toBeUndefined();
  });
});
