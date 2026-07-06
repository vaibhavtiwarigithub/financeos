import { describe, it, expect } from "vitest";
import { computeNav } from "@/lib/paper/nav-math";

describe("nav-math (currency isolation — Codex review fix)", () => {
  it("computes cash + mark-to-market for a single-market position set", () => {
    const nav = computeNav(1000, [
      { market: "us", qty: 10, price: 50 },  // 500
      { market: "us", qty: 2, price: 100 },  // 200
    ]);
    expect(nav).toBe(1000 + 500 + 200);
  });

  it("throws when positions span more than one market (never silently blend $ and ₹)", () => {
    expect(() => computeNav(1000, [
      { market: "us", qty: 10, price: 50 },
      { market: "india", qty: 100, price: 2000 },
    ])).toThrow(/mixed markets/i);
  });

  it("handles an empty position set (cash-only NAV)", () => {
    expect(computeNav(500, [])).toBe(500);
  });

  it("india-only positions compute correctly (no market column bleed)", () => {
    const nav = computeNav(1000000, [{ market: "india", qty: 10, price: 2500 }]);
    expect(nav).toBe(1000000 + 25000);
  });
});
