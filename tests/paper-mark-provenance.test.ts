// W4 detectors. Every test here FAILS if the fix regresses.
//
// The defect these replace: position-monitor computed `newNav` and
// `invariantExpected` from the same reduce over the same array and compared
// them, so `invariantDiff` was structurally zero and the violation branch was
// unreachable. The regression guard is the first test: it feeds a persisted NAV
// that disagrees with the marks and REQUIRES a violation. A self-comparison
// cannot produce one.

import { describe, expect, it } from "vitest";
import {
  buildPositionMark,
  markLedgerRow,
  navFromMarks,
  reconcilePersistedNav,
  summariseMarkCoverage,
  type PositionMark,
} from "@/lib/paper/marks";

const mark = (over: Partial<PositionMark> = {}): PositionMark => ({
  positionId: "p1", symbol: "AAPL", market: "us", qty: 10, mark: 100,
  source: "massive", observedAt: "2026-08-16T20:00:00.000Z",
  provenance: "live_quote", stale: false, ageDays: 0, reason: "fresh quote",
  ...over,
});

const reconcile = (over: Partial<Parameters<typeof reconcilePersistedNav>[0]> = {}) =>
  reconcilePersistedNav({
    market: "us", cash: 1000, marks: [mark()],
    persistedPortfolioNav: 2000, persistedPortfolioCash: 1000, persistedPerformanceNav: 2000,
    ...over,
  });

describe("NAV invariant is falsifiable (the old one was not)", () => {
  it("passes when the persisted book agrees with cash + marks", () => {
    const r = reconcile();
    expect(r.navFromMarks).toBe(2000);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  // THE detector. The pre-W4 check could not fail this input.
  it("FAILS when persisted paper_portfolio.nav disagrees with the marks", () => {
    const r = reconcile({ persistedPortfolioNav: 2100 });
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("paper_portfolio.nav");
  });

  it("FAILS when persisted paper_performance.nav disagrees with the marks", () => {
    const r = reconcile({ persistedPerformanceNav: 1999 });
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("paper_performance.nav");
  });

  it("FAILS when a write did not land at all (value absent)", () => {
    const r = reconcile({ persistedPortfolioNav: null });
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("the write did not land");
  });

  it("FAILS when persisted cash disagrees with the cash this run credited", () => {
    const r = reconcile({ persistedPortfolioCash: 900 });
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("paper_portfolio.cash_balance");
  });

  it("FAILS when an open qty carries no usable mark", () => {
    const marks = [mark(), mark({ positionId: "p2", symbol: "MSFT", qty: 5, mark: 0 })];
    const r = reconcile({ marks, persistedPortfolioNav: 2000, persistedPerformanceNav: 2000 });
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("MSFT");
  });

  it("FAILS when cash breaks the seed - open cost + realized identity", () => {
    const r = reconcile({ ledgerCash: 5000 });
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("cash_ledger_identity");
  });

  it("tolerates float-summation noise but not real drift", () => {
    expect(reconcile({ persistedPortfolioNav: 2000.005 }).ok).toBe(true);
    expect(reconcile({ persistedPortfolioNav: 2000.5 }).ok).toBe(false);
  });

  it("refuses to sum currencies into one NAV", () => {
    expect(() => navFromMarks(0, [mark(), mark({ market: "india", symbol: "INFY" })]))
      .toThrow(/currencies must never be summed/);
  });
});

describe("every mark carries provenance and a session timestamp", () => {
  const now = new Date("2026-08-16T20:00:00.000Z");

  it("a fresh quote is a live mark with its own observation time", () => {
    const m = buildPositionMark({
      positionId: "p1", symbol: "AAPL", market: "us", qty: 10, avgCost: 90,
      livePrice: 100, liveSource: "massive", liveObservedAt: "2026-08-16T19:59:00.000Z",
      persistedPrice: 95, persistedAt: "2026-08-15T20:00:00.000Z",
    }, now);
    expect(m.provenance).toBe("live_quote");
    expect(m.stale).toBe(false);
    expect(m.mark).toBe(100);
    expect(m.source).toBe("massive");
    expect(m.observedAt).toBe("2026-08-16T19:59:00.000Z");
  });

  // The silent blend: no fresh quote, so NAV kept yesterday's price with no
  // record that it had done so.
  it("no fresh quote carries the previous mark and says so, with its age", () => {
    const m = buildPositionMark({
      positionId: "p1", symbol: "LNC", market: "us", qty: 10, avgCost: 40,
      livePrice: null, persistedPrice: 35.39, persistedAt: "2026-08-13T20:00:00.000Z",
    }, now);
    expect(m.provenance).toBe("carry_forward");
    expect(m.stale).toBe(true);
    expect(m.mark).toBe(35.39);
    expect(Math.round(m.ageDays!)).toBe(3);
    expect(m.reason).toMatch(/carried last persisted mark/);
  });

  it("never priced at all falls back to entry cost, explicitly", () => {
    const m = buildPositionMark({
      positionId: "p1", symbol: "XAR", market: "us", qty: 3, avgCost: 282.22,
      livePrice: null, persistedPrice: null,
    }, now);
    expect(m.provenance).toBe("entry_cost");
    expect(m.stale).toBe(true);
    expect(m.mark).toBe(282.22);
    expect(m.reason).toMatch(/never priced/);
  });

  it("a non-positive live price is not a mark", () => {
    const m = buildPositionMark({
      positionId: "p1", symbol: "AAPL", market: "us", qty: 1, avgCost: 90,
      livePrice: 0, persistedPrice: 95, persistedAt: "2026-08-15T20:00:00.000Z",
    }, now);
    expect(m.provenance).toBe("carry_forward");
  });
});

describe("mixed-age marks are explicit and reportable", () => {
  it("reports the share of position value carried on stale marks", () => {
    const cov = summariseMarkCoverage([
      mark({ qty: 10, mark: 100 }),
      mark({ positionId: "p2", symbol: "LNC", qty: 10, mark: 100, provenance: "carry_forward", stale: true }),
    ]);
    expect(cov.totalQty).toBe(20);
    expect(cov.liveQty).toBe(10);
    expect(cov.carryForwardQty).toBe(10);
    expect(cov.staleValue).toBe(1000);
    expect(cov.staleValuePct).toBe(50);
    expect(cov.unmarked).toEqual([]);
  });

  it("names positions whose mark is unusable", () => {
    expect(summariseMarkCoverage([mark({ symbol: "ZZZ", mark: 0 })]).unmarked).toEqual(["ZZZ"]);
  });
});

describe("mark ledger row", () => {
  it("carries run, session, provenance and reason — what was never written before", () => {
    const row = markLedgerRow(mark(), { runId: "position_monitor:2026-08-16T20:00:00Z", sessionDate: "2026-08-16" });
    expect(row).toMatchObject({
      run_id: "position_monitor:2026-08-16T20:00:00Z",
      session_date: "2026-08-16",
      market: "us", symbol: "AAPL", qty: 10, mark_price: 100,
      source: "massive", provenance: "live_quote", stale: false,
    });
    expect(row.observed_at).toBe("2026-08-16T20:00:00.000Z");
    expect(row.reason.length).toBeGreaterThan(0);
  });

  // Mirrors the CHECK constraints in the migration: the DB refuses what the
  // code should already have refused.
  it("a live mark always has the observation time the DB constraint demands", () => {
    const row = markLedgerRow(mark({ observedAt: null, provenance: "carry_forward", stale: true }), {
      runId: "r", sessionDate: "2026-08-16",
    });
    expect(row.provenance).not.toBe("live_quote");
    expect(row.stale).toBe(row.provenance !== "live_quote");
  });
});
