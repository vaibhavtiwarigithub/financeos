import { describe, expect, it } from "vitest";
import { paperPerformanceTruth, resolvedPaperOutcomeCount } from "@/lib/paper-nav";

describe("paperPerformanceTruth", () => {
  it("derives India P&L from the INR seed, not a prior writer's stale fields", () => {
    const truth = paperPerformanceTruth({
      market: "india",
      nav: 997_498.38,
      previousNav: 990_602.82,
      benchReturnPct: 1.1505333267,
      winCount: 4,
      lossCount: 8,
      resolvedTradeCount: 13,
    });
    expect(truth).toMatchObject({
      win_count: 4,
      loss_count: 8,
      win_rate: 4 / 13,
    });
    expect(truth.daily_pnl).toBeCloseTo(6_895.56, 6);
    expect(truth.total_pnl).toBeCloseTo(-2_501.62, 6);
    expect(truth.total_pnl_pct).toBeCloseTo(-0.250162, 9);
    expect(truth.alpha_pct).toBeCloseTo(-1.4006953267, 9);
  });

  it("keeps the US and India seeds isolated", () => {
    const us = paperPerformanceTruth({
      market: "us", nav: 9_950, previousNav: null, benchReturnPct: null,
      winCount: 0, lossCount: 0, resolvedTradeCount: 0,
    });
    const india = paperPerformanceTruth({
      market: "india", nav: 995_000, previousNav: null, benchReturnPct: null,
      winCount: 0, lossCount: 0, resolvedTradeCount: 0,
    });
    expect(us.total_pnl_pct).toBe(-0.5);
    expect(india.total_pnl_pct).toBe(-0.5);
    expect(us.daily_pnl).toBe(0);
    expect(india.daily_pnl).toBe(0);
  });

  it("counts breakevens in the resolved-trade denominator", () => {
    const truth = paperPerformanceTruth({
      market: "india", nav: 1_000_000, previousNav: 1_000_000, benchReturnPct: 0,
      winCount: 4, lossCount: 8, resolvedTradeCount: 13,
    });
    expect(truth.win_rate).toBe(4 / 13);
  });

  it("does not relabel null or unknown outcomes as breakeven", () => {
    expect(resolvedPaperOutcomeCount([
      { outcome: "win" },
      { outcome: "loss" },
      { outcome: "breakeven" },
      { outcome: null },
      { outcome: "unknown" },
    ])).toBe(3);
  });
});
