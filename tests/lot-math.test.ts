import { describe, it, expect } from "vitest";
import { lotRealizedPnl, lotPnlPct, lotOutcome } from "@/lib/paper/lot-math";

describe("lot-math (per-lot P&L — Codex review fix)", () => {
  it("computes independent P&L for two lots of the same symbol at different entry prices", () => {
    const lotA = { qty: 10, fillPrice: 100 };
    const lotB = { qty: 5, fillPrice: 120 };
    const exit = 110;

    const pnlA = lotRealizedPnl(lotA, exit); // (110-100)*10 = 100
    const pnlB = lotRealizedPnl(lotB, exit); // (110-120)*5 = -50

    expect(pnlA).toBe(100);
    expect(pnlB).toBe(-50);
    // The bug this guards: stamping the AGGREGATE position P&L onto every lot
    // would give both lots the same number — assert they differ here.
    expect(pnlA).not.toBe(pnlB);
  });

  it("classifies win/loss/breakeven around the 0.5 threshold", () => {
    expect(lotOutcome(0.51)).toBe("win");
    expect(lotOutcome(-0.51)).toBe("loss");
    expect(lotOutcome(0.49)).toBe("breakeven");
    expect(lotOutcome(-0.49)).toBe("breakeven");
    expect(lotOutcome(0)).toBe("breakeven");
  });

  it("pnlPct is proportional to entry price, not absolute P&L", () => {
    const cheap = { qty: 100, fillPrice: 1 };
    const expensive = { qty: 1, fillPrice: 1000 };
    // Same 10% move for both
    expect(lotPnlPct(cheap, 1.1)).toBeCloseTo(10, 5);
    expect(lotPnlPct(expensive, 1100)).toBeCloseTo(10, 5);
  });

  it("pnlPct is 0 when fillPrice is not positive (guards div-by-zero)", () => {
    expect(lotPnlPct({ qty: 1, fillPrice: 0 }, 10)).toBe(0);
  });
});
