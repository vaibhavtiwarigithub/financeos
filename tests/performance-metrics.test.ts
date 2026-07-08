import { describe, it, expect } from "vitest";
import {
  navToReturns, sharpe, sortino, maxDrawdown, expectancy, costNet, calibration,
  MIN_RETURNS, MIN_TRADES, MIN_CALIB,
} from "@/lib/analytics/performance-metrics";

// Build 3 — golden tests for the pure metrics lib. These lock the HONESTY
// CONTRACT (small samples => insufficient, never a fake number) and the math
// for each estimator against hand-built fixtures.

// Helper: build N daily returns all equal to `r`.
const constReturns = (n: number, r: number) => Array.from({ length: n }, () => r);
// Helper: build N closed trades with the given pnl_pct values.
const trades = (pnls: number[]) => pnls.map((p) => ({ pnl_pct: p }));

describe("navToReturns", () => {
  it("computes period-over-period simple returns", () => {
    const r = navToReturns([100, 110, 99]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.1, 10);
    expect(r[1]).toBeCloseTo(-0.1, 10);
  });
  it("drops steps with non-positive or non-finite prior NAV", () => {
    const r = navToReturns([0, 100, 110]); // prev=0 dropped
    expect(r).toHaveLength(1);
    expect(r[0]).toBeCloseTo(0.1, 10);
    expect(navToReturns([100])).toEqual([]); // single point
    expect(navToReturns([])).toEqual([]);
  });
});

describe("sharpe", () => {
  it("is insufficient below MIN_RETURNS", () => {
    const s = sharpe(constReturns(MIN_RETURNS - 1, 0.001));
    expect(s.insufficient).toBe(true);
    expect(s.value).toBeNull();
  });
  it("is insufficient when there is no dispersion (std=0)", () => {
    // Enough points, but zero-variance series => std exactly 0 => undefined ratio.
    // (Use exact 0s: any float-representable constant leaks epsilon variance.)
    const s = sharpe(constReturns(MIN_RETURNS + 5, 0));
    expect(s.insufficient).toBe(true);
    expect(s.value).toBeNull();
  });
  it("annualizes a real dispersion series", () => {
    // 30 returns alternating +1%/-0.5%: positive mean, real std.
    const r = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.005));
    const s = sharpe(r);
    expect(s.insufficient).toBe(false);
    expect(s.value).not.toBeNull();
    expect(Number.isFinite(s.value!)).toBe(true);
    expect(s.value!).toBeGreaterThan(0); // positive mean => positive sharpe
  });
});

describe("sortino", () => {
  it("is insufficient when there is no downside (denominator 0)", () => {
    const s = sortino(constReturns(MIN_RETURNS + 5, 0.002));
    expect(s.insufficient).toBe(true);
    expect(s.value).toBeNull();
  });
  it("penalizes only downside deviation", () => {
    const r = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? -0.01 : 0.008));
    const s = sortino(r);
    expect(s.insufficient).toBe(false);
    expect(Number.isFinite(s.value!)).toBe(true);
  });
});

describe("maxDrawdown", () => {
  it("returns 0 for a monotonically rising series", () => {
    const nav = Array.from({ length: 25 }, (_, i) => 100 + i);
    const dd = maxDrawdown(nav);
    expect(dd.insufficient).toBe(false);
    expect(dd.value).toBe(0);
  });
  it("captures the worst peak-to-trough as a negative fraction", () => {
    // peak 120 -> trough 90 = -25%. Pad to satisfy MIN_RETURNS.
    const nav = [100, 110, 120, 90, ...Array.from({ length: 20 }, () => 95)];
    const dd = maxDrawdown(nav);
    expect(dd.insufficient).toBe(false);
    expect(dd.value!).toBeCloseTo(-0.25, 5);
  });
  it("is insufficient with a single level", () => {
    expect(maxDrawdown([100]).insufficient).toBe(true);
  });
});

describe("expectancy", () => {
  it("is insufficient below MIN_TRADES", () => {
    const e = expectancy(trades([1, -1, 2]));
    expect(e.insufficient).toBe(true);
    expect(e.value).toBeNull();
  });
  it("computes mean, win rate, avg win/loss, profit factor", () => {
    // 20 trades: 12 wins of +2, 8 losses of -1.
    const pnls = [...Array(12).fill(2), ...Array(8).fill(-1)];
    const e = expectancy(trades(pnls));
    expect(e.insufficient).toBe(false);
    expect(e.value!).toBeCloseTo((12 * 2 - 8 * 1) / 20, 6); // = 0.8
    expect(e.winRate!).toBeCloseTo(0.6, 6);
    expect(e.avgWin!).toBeCloseTo(2, 6);
    expect(e.avgLoss!).toBeCloseTo(-1, 6);
    // PF = grossWin/grossLoss = 24/8 = 3
    expect(e.profitFactor.value!).toBeCloseTo(3, 6);
  });
  it("reports profit factor null when there are no losses", () => {
    const e = expectancy(trades(Array(20).fill(1)));
    expect(e.profitFactor.value).toBeNull(); // grossLoss 0 => undefined
  });
});

describe("costNet", () => {
  it("expresses spread as % of fill and reconstructs gross = net + cost", () => {
    // 20 identical rows: net 1%, spread 0.05 on fill 100 => cost 0.05%.
    const rows = Array.from({ length: 20 }, () => ({
      pnl_pct: 1, spread_applied: 0.05, fill_price: 100,
    }));
    const c = costNet(rows);
    expect(c.netReturnPct.value!).toBeCloseTo(1, 6);
    expect(c.costPct.value!).toBeCloseTo(0.05, 6);
    expect(c.grossReturnPct.value!).toBeCloseTo(1.05, 6);
  });
  it("treats missing/invalid spread as zero cost", () => {
    const rows = Array.from({ length: 20 }, () => ({
      pnl_pct: 1, spread_applied: null, fill_price: null,
    }));
    const c = costNet(rows);
    expect(c.costPct.value!).toBeCloseTo(0, 6);
    expect(c.grossReturnPct.value!).toBeCloseTo(1, 6);
  });
});

describe("calibration", () => {
  it("is insufficient below MIN_CALIB", () => {
    const pts = Array.from({ length: MIN_CALIB - 1 }, () => ({ predicted: 0.7, win: true }));
    expect(calibration(pts).insufficient).toBe(true);
  });
  it("buckets by decile and computes realized win rate per bucket", () => {
    // 10 points at 0.65 (bucket 6), 6 wins => realized 0.6.
    const pts = [
      ...Array(6).fill({ predicted: 0.65, win: true }),
      ...Array(4).fill({ predicted: 0.65, win: false }),
    ];
    const c = calibration(pts);
    expect(c.insufficient).toBe(false);
    expect(c.bins).toHaveLength(1);
    expect(c.bins[0].bucket).toBe(6);
    expect(c.bins[0].predicted).toBeCloseTo(0.65, 6);
    expect(c.bins[0].realized).toBeCloseTo(0.6, 6);
    expect(c.bins[0].n).toBe(10);
  });
  it("maps predicted==1 into the last bucket, drops out-of-range", () => {
    const pts = [
      ...Array(10).fill({ predicted: 1, win: true }),
      { predicted: 1.5, win: true },   // out of range -> dropped
      { predicted: -0.1, win: false }, // out of range -> dropped
    ];
    const c = calibration(pts, 10);
    expect(c.n).toBe(10); // only the in-range points counted
    expect(c.bins[c.bins.length - 1].bucket).toBe(9); // predicted 1 -> last bucket
  });
});
