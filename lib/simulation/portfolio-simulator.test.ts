import { describe, expect, it } from "vitest";
import { simulatePortfolio } from "./portfolio-simulator";

describe("simulatePortfolio", () => {
  it("processes same-session exits before entries so released cash redeploys once", () => {
    const result = simulatePortfolio(
      { market: "us", currency: "USD", initialCash: 100, maxOpenNames: 1, allowFractionalShares: true },
      [
        { id: "buy-a", session: "2026-08-01", symbol: "AAA", kind: "entry", price: 100, quantity: 1 },
        { id: "buy-b", session: "2026-08-02", symbol: "BBB", kind: "entry", price: 100, quantity: 1 },
        { id: "sell-a", session: "2026-08-02", symbol: "AAA", kind: "exit", price: 110, quantity: 1 },
      ],
    );
    expect(result.rejections).toEqual([]);
    expect(result.fills.map((f) => f.eventId)).toEqual(["buy-a", "sell-a", "buy-b"]);
    expect(result.endingCash).toBe(10);
    expect(result.realizedPnl).toBe(10);
    expect(result.positions).toEqual([{ symbol: "BBB", quantity: 1, costBasis: 100 }]);
  });

  it("rejects cross-currency policy and whole-share violations", () => {
    expect(() => simulatePortfolio(
      { market: "india", currency: "USD", initialCash: 100, maxOpenNames: 1, allowFractionalShares: false }, [],
    )).toThrow("india simulation must use INR");

    const result = simulatePortfolio(
      { market: "india", currency: "INR", initialCash: 1000, maxOpenNames: 2, allowFractionalShares: false },
      [{ id: "fraction", session: "2026-08-01", symbol: "RELIANCE.NS", kind: "entry", price: 100, quantity: 0.5 }],
    );
    expect(result.rejections).toEqual([{ eventId: "fraction", reason: "fractional_not_allowed" }]);
    expect(result.endingCash).toBe(1000);
  });

  it("is deterministic and does not permit cash overspend", () => {
    const policy = { market: "us" as const, currency: "USD" as const, initialCash: 100, maxOpenNames: 2, allowFractionalShares: true };
    const events = [
      { id: "too-large", session: "2026-08-01", symbol: "AAA", kind: "entry" as const, price: 101, quantity: 1 },
      { id: "allocation", session: "2026-08-01", symbol: "BBB", kind: "entry" as const, price: 40, cashAllocation: 100, costPct: 0.01 },
    ];
    const first = simulatePortfolio(policy, events);
    expect(first.rejections).toContainEqual({ eventId: "too-large", reason: "insufficient_cash" });
    expect(first.endingCash).toBeCloseTo(0);
    expect(simulatePortfolio(policy, [...events].reverse())).toEqual(first);
  });
});
