import { describe, it, expect } from "vitest";
import { replacementCapacity } from "@/lib/trading/rotation-capacity";
import { DEFAULT_LIMITS } from "@/lib/portfolio/constructor";
import { paperIntendedSpend, paperAllocationSpend } from "@/lib/trading/paper-quantity";

const args = {
  book: [
    { symbol: "OLD", sector: "energy", valuePct: 5, beta: null, dailyVol: null },
    { symbol: "OTHER", sector: "technology", valuePct: 75.58, beta: null, dailyVol: null },
  ],
  sourceSymbol: "OLD", sellNotional: 500, symbol: "BE", market: "us" as const,
  sector: "energy", dailyVol: null, intendedNotional: 1955, nav: 10000,
  cash: 1500, fillPrice: 100, limits: DEFAULT_LIMITS, maxPerSector: 4,
};
describe("replacement sizing", () => {
  it("keeps intended allocation available when cash is zero", () => {
    expect(paperIntendedSpend(10000, 10)).toBe(1000);
    expect(paperAllocationSpend(10000, 0, 10)).toBeNull();
  });
  it("shrinks an oversized BE-style request to actual post-sale gross room", () => {
    const result = replacementCapacity(args);
    expect(result.reason).toBeNull();
    expect(result.buyNotional).toBeCloseTo(442, 3);
  });
  it("reserves adverse sell slippage when funding from a fully invested book", () => {
    const result = replacementCapacity({ ...args, cash: 0, limits: { ...DEFAULT_LIMITS, maxGrossExposurePct: 100 } });
    expect(result.buyNotional).toBeCloseTo(499.75, 3);
  });
  it("allows same-sector replacement but rejects a swap leaving the sector full", () => {
    const book = args.book.map(p => ({ ...p, valuePct: 5 }));
    expect(replacementCapacity({ ...args, book, maxPerSector: 1 }).reason).toBeNull();
    expect(replacementCapacity({ ...args, book, sourceSymbol: "OTHER", maxPerSector: 1 }).reason).toBe("post_swap_sector_count_cap");
  });
  it("fails closed without a source or executable allocation", () => {
    expect(replacementCapacity({ ...args, sourceSymbol: "MISSING" }).buyNotional).toBe(0);
    expect(replacementCapacity({ ...args, fillPrice: NaN }).buyNotional).toBe(0);
  });
});
