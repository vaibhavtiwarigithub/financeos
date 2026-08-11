import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paperAllocationSpend } from "@/lib/trading/paper-quantity";

describe("paperAllocationSpend", () => {
  it("sizes an approved allocation from market-local NAV, not remaining cash", () => {
    expect(paperAllocationSpend(10_000, 4_000, 10)).toBe(1_000);
  });

  it("never spends more than available cash or the per-order cap", () => {
    expect(paperAllocationSpend(10_000, 600, 10)).toBe(600);
    expect(paperAllocationSpend(10_000, 4_000, 10, 750)).toBe(750);
  });

  it("fails closed for malformed allocation inputs", () => {
    expect(paperAllocationSpend(10_000, 4_000, Number.NaN)).toBeNull();
    expect(paperAllocationSpend(0, 4_000, 10)).toBeNull();
  });

  it("builds the market-local NAV book from current marks with cost fallback", () => {
    const route = readFileSync("app/api/agents/paper-trade/route.ts", "utf8");
    expect(route).toContain("avg_cost, current_price, market");
    expect(route).toContain("Number.isFinite(marked) && marked > 0 ? marked : cost");
    expect(route).toContain("paperAllocationSpend(");
  });
});
