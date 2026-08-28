import { describe, it, expect } from "vitest";
import {
  orderSessionEvents, runPortfolioCalendar, runA6Portfolio, runA9RiskGeometry,
  type CalendarEvent, type DailyMark, type GeometryLot,
} from "./alpha-diagnostics-portfolio";
import type { SimulationPolicy } from "@/lib/simulation/portfolio-simulator";

const policy: SimulationPolicy = {
  market: "us", currency: "USD", initialCash: 1000,
  maxOpenNames: 5, allowFractionalShares: true,
};

describe("orderSessionEvents", () => {
  // Exits MUST precede entries in the same session or the released capital is
  // not available to that session's entries, which understates redeployment.
  it("puts exits before entries within a session", () => {
    const out = orderSessionEvents([
      { session: "2026-08-19", symbol: "BBB", kind: "entry", price: 10, rank: 1 },
      { session: "2026-08-19", symbol: "AAA", kind: "exit", price: 20, quantity: 1 },
    ]);
    expect(out.map(e => e.kind)).toEqual(["exit", "entry"]);
  });

  it("orders entries by rank, best first", () => {
    const out = orderSessionEvents([
      { session: "d", symbol: "B", kind: "entry", price: 1, rank: 2 },
      { session: "d", symbol: "A", kind: "entry", price: 1, rank: 1 },
    ]);
    expect(out.map(e => e.symbol)).toEqual(["A", "B"]);
  });

  // Without this the byte-identical rerun gate is unsatisfiable in principle.
  it("breaks equal ranks lexically so ordering is reproducible", () => {
    const a = orderSessionEvents([
      { session: "d", symbol: "ZZZ", kind: "entry", price: 1, rank: 1 },
      { session: "d", symbol: "AAA", kind: "entry", price: 1, rank: 1 },
    ]);
    const b = orderSessionEvents([
      { session: "d", symbol: "AAA", kind: "entry", price: 1, rank: 1 },
      { session: "d", symbol: "ZZZ", kind: "entry", price: 1, rank: 1 },
    ]);
    expect(a.map(e => e.symbol)).toEqual(["AAA", "ZZZ"]);
    expect(a).toEqual(b);
  });

  it("sorts across sessions chronologically", () => {
    const out = orderSessionEvents([
      { session: "2026-08-20", symbol: "A", kind: "entry", price: 1 },
      { session: "2026-08-19", symbol: "B", kind: "entry", price: 1 },
    ]);
    expect(out.map(e => e.session)).toEqual(["2026-08-19", "2026-08-20"]);
  });
});

describe("runPortfolioCalendar", () => {
  const marks = (rows: [string, Record<string, number>, number?][]): DailyMark[] =>
    rows.map(([session, prices, bench]) => ({ session, prices, benchClose: bench ?? null }));

  it("marks NAV daily and never lets cash go negative", () => {
    const events: CalendarEvent[] = [
      { session: "2026-08-19", symbol: "AAA", kind: "entry", price: 10, cashAllocation: 500 },
    ];
    const r = runPortfolioCalendar(policy, events, marks([
      ["2026-08-19", { AAA: 10 }],
      ["2026-08-20", { AAA: 12 }],
    ]));
    expect(r.points).toHaveLength(2);
    for (const p of r.points) expect(p.cash).toBeGreaterThanOrEqual(0);
    // 50 shares at 12 = 600, plus 500 cash = 1100.
    expect(r.points[1].nav).toBeCloseTo(1100, 6);
    expect(r.totalReturnPct).toBeCloseTo(10, 6);
  });

  it("releases cash on exit and lets the same session redeploy it", () => {
    const events: CalendarEvent[] = [
      { session: "d1", symbol: "AAA", kind: "entry", price: 10, cashAllocation: 1000 },
      // d2: exit AAA (frees 1000), then enter BBB with it.
      // The simulator requires an explicit exit quantity; an exit without one
      // is rejected as invalid_exit rather than assumed to be the whole lot.
      { session: "d2", symbol: "AAA", kind: "exit", price: 10, quantity: 100 },
      { session: "d2", symbol: "BBB", kind: "entry", price: 10, cashAllocation: 1000, rank: 1 },
    ];
    const r = runPortfolioCalendar(policy, events, marks([
      ["d1", { AAA: 10 }],
      ["d2", { BBB: 10 }],
    ]));
    // If exits did not precede entries the BBB entry would be rejected for cash.
    expect(r.points[1].positionsValue).toBeCloseTo(1000, 6);
    expect(r.points[1].cashUtilization).toBeCloseTo(1, 6);
  });

  // A missing quote is missing information, not a wipeout.
  it("falls back to cost basis rather than marking an unpriced position to zero", () => {
    const events: CalendarEvent[] = [
      { session: "d1", symbol: "AAA", kind: "entry", price: 10, cashAllocation: 500 },
    ];
    const r = runPortfolioCalendar(policy, events, marks([
      ["d1", { AAA: 10 }],
      ["d2", {}],  // no price for AAA
    ]));
    expect(r.points[1].nav).toBeCloseTo(1000, 6);
    expect(r.points[1].positionsValue).toBeCloseTo(500, 6);
  });

  it("tracks drawdown from the running peak", () => {
    const events: CalendarEvent[] = [
      { session: "d1", symbol: "AAA", kind: "entry", price: 10, cashAllocation: 1000 },
    ];
    const r = runPortfolioCalendar(policy, events, marks([
      ["d1", { AAA: 10 }],
      ["d2", { AAA: 20 }],   // NAV 2000, new peak
      ["d3", { AAA: 15 }],   // NAV 1500, 25% off peak
    ]));
    expect(r.maxDrawdownPct).toBeCloseTo(25, 4);
  });

  it("computes net excess against the benchmark when both endpoints are known", () => {
    const events: CalendarEvent[] = [
      { session: "d1", symbol: "AAA", kind: "entry", price: 10, cashAllocation: 1000 },
    ];
    const r = runPortfolioCalendar(policy, events, marks([
      ["d1", { AAA: 10 }, 100],
      ["d2", { AAA: 11 }, 105],   // portfolio +10%, bench +5%
    ]));
    expect(r.benchTotalReturnPct).toBeCloseTo(5, 6);
    expect(r.netExcessReturnPp).toBeCloseTo(5, 6);
  });

  it("returns a null excess rather than inventing one when the benchmark is absent", () => {
    const r = runPortfolioCalendar(policy, [], marks([["d1", {}], ["d2", {}]]));
    expect(r.benchTotalReturnPct).toBeNull();
    expect(r.netExcessReturnPp).toBeNull();
  });
});

describe("runA6Portfolio", () => {
  const arm = (name: string, totalReturnPct: number, maxDrawdownPct: number, util = 0.8) => ({
    name,
    result: {
      points: [{ session: "d1", cash: 0, positionsValue: 0, nav: 100, cashUtilization: util, benchNav: 100, drawdownPct: 0 }],
      endingNav: 100, maxDrawdownPct, meanCashUtilization: util,
      totalReturnPct, benchTotalReturnPct: 2, netExcessReturnPp: totalReturnPct - 2,
      rejections: [],
    },
  });

  it("pairs every arm against actual on the same sessions", () => {
    const f = runA6Portfolio("us", [arm("actual", 3, 10), arm("equal_size", 5, 12)]);
    const eq = (f.metrics.comparisons as any[]).find(c => c.arm === "equal_size");
    expect(eq.excessVsActualPp).toBeCloseTo(2, 6);
    // Won on return but deepened drawdown -- reported, not hidden.
    expect(eq.drawdownVsActualPp).toBeCloseTo(2, 6);
  });

  it("measures cash drag from the benchmark actually earned, not an assumption", () => {
    const f = runA6Portfolio("us", [arm("actual", 3, 10, 0.5)]);
    // 50% uninvested against a +2% benchmark.
    expect(f.metrics.cashDragPp as number).toBeCloseTo(1, 6);
  });

  it("refuses an empty calendar", () => {
    expect(runA6Portfolio("us", []).status).toBe("insufficient_evidence");
  });
});

describe("A9 risk geometry", () => {
  const lot = (openedAt: string, stopPct: number, targetPct: number): GeometryLot => ({
    symbol: `S${openedAt}${targetPct}`, openedAt, stopPct, targetPct,
  });

  // The real production shape: legacy 20% targets alongside current 8% ones.
  it("separates vintages so a legacy target cannot flatter current policy", () => {
    const f = runA9RiskGeometry("india", [
      lot("2026-07-10", 7, 20),
      lot("2026-08-20", 7, 8),
    ]);
    const v = f.metrics.vintages as any[];
    expect(v).toHaveLength(2);
    expect(v[0].meanRewardRisk).toBeCloseTo(20 / 7, 6);
    expect(v[1].meanRewardRisk).toBeCloseTo(8 / 7, 6);
    expect(f.metrics.distinctTargetLevels).toBe(2);
    expect(f.reason).toContain("mandate vintage");
  });

  it("reports a single vintage cleanly when policy has not drifted", () => {
    const f = runA9RiskGeometry("us", [lot("2026-08-20", 7, 8), lot("2026-08-21", 7, 8)]);
    expect(f.metrics.distinctTargetLevels).toBe(1);
    expect(f.metrics.overallRewardRisk as number).toBeCloseTo(8 / 7, 6);
  });

  it("skips lots with a non-positive stop rather than dividing by zero", () => {
    const f = runA9RiskGeometry("us", [lot("2026-08-20", 0, 8), lot("2026-08-20", 7, 8)]);
    expect(f.sample.nRows).toBe(1);
    expect(f.coverage).toBeCloseTo(0.5, 6);
  });
});
