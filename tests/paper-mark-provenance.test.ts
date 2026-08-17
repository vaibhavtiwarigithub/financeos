import { describe, expect, it } from "vitest";
import {
  buildPositionMark,
  markLedgerRow,
  navFromMarks,
  reconcilePersistedNav,
} from "@/lib/paper/marks";

const base = {
  positionId: "p1", symbol: "TEST", market: "us" as const,
  qty: 2, avgCost: 100, persistedPrice: 101, persistedAt: "2026-08-15T20:00:00.000Z",
};

describe("paper position mark provenance", () => {
  it("uses a fresh run quote with its source timestamp", () => {
    const mark = buildPositionMark({ ...base, livePrice: 105, liveSource: "massive", liveObservedAt: "2026-08-16T20:00:00.000Z" }, new Date("2026-08-16T21:00:00.000Z"));
    expect(mark).toMatchObject({ mark: 105, provenance: "live_quote", stale: false, source: "massive" });
  });

  it("makes an absent fresh quote explicit rather than silently treating it as fresh", () => {
    const mark = buildPositionMark(base, new Date("2026-08-16T21:00:00.000Z"));
    expect(mark).toMatchObject({ mark: 101, provenance: "carry_forward", stale: true });
  });

  it("falls back to entry cost only when no persisted mark exists", () => {
    const mark = buildPositionMark({ ...base, persistedPrice: null, persistedAt: null });
    expect(mark).toMatchObject({ mark: 100, provenance: "entry_cost", stale: true });
  });

  it("detects a persisted NAV write that differs from the independently computed mark NAV", () => {
    const mark = buildPositionMark({ ...base, livePrice: 105, liveSource: "massive", liveObservedAt: "2026-08-16T20:00:00.000Z" });
    const expected = navFromMarks(500, [mark]);
    const result = reconcilePersistedNav({
      market: "us", cash: 500, marks: [mark],
      persistedPortfolioNav: expected + 10,
      persistedPortfolioCash: 500,
      persistedPerformanceNav: expected,
      ledgerCash: 500,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("paper_portfolio.nav");
  });

  it("emits all provenance fields into the append-only ledger shape", () => {
    const mark = buildPositionMark({ ...base, livePrice: 105, liveSource: "massive", liveObservedAt: "2026-08-16T20:00:00.000Z" });
    expect(markLedgerRow(mark, { runId: "run-1", sessionDate: "2026-08-16" })).toMatchObject({
      run_id: "run-1", session_date: "2026-08-16", position_id: "p1",
      mark_price: 105, provenance: "live_quote", stale: false,
    });
  });
});
