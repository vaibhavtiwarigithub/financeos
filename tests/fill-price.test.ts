import { describe, it, expect } from "vitest";
import { computeFillPrice } from "@/lib/data/quotes";

describe("computeFillPrice", () => {
  it("uses ask price + 0.05% slippage when ask is present", () => {
    const fill = computeFillPrice({ price: 100, ask: 100.5, bid: 99.5, source: "test", retrievedAt: "" } as any);
    expect(fill).toBeCloseTo(100.5 * 1.0005, 4);
  });

  it("falls back to price + 0.05% slippage when ask is absent", () => {
    const fill = computeFillPrice({ price: 50, ask: null, bid: null, source: "test", retrievedAt: "" } as any);
    expect(fill).toBeCloseTo(50 * 1.0005, 4);
  });

  it("never returns a fill price below the base price (slippage always adds cost)", () => {
    const fill = computeFillPrice({ price: 10, ask: 10, bid: 10, source: "test", retrievedAt: "" } as any);
    expect(fill).toBeGreaterThan(10);
  });
});
