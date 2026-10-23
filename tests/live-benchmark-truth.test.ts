import { describe, expect, it } from "vitest";
import { canonicalLiveEquitySnapshots, type LiveEquityRow } from "@/lib/analytics/benchmark-display";
import { buildBenchmarkWindow } from "@/lib/analytics/benchmark-window";
import { readFileSync } from "node:fs";

const row = (account_id: string, date: string, equity: number | null, rest: Partial<LiveEquityRow> = {}): LiveEquityRow =>
  ({ account_id, date, equity, market: "us", currency: "USD", ...rest });

describe("fixed live account equity cohort", () => {
  it("does not call adding a new account a portfolio gain", () => {
    expect(canonicalLiveEquitySnapshots([
      row("a", "2026-10-19", 100), row("a", "2026-10-20", 105), row("b", "2026-10-20", 1000),
    ], "us")).toMatchObject({ accountCount: 2, incompleteSessions: 1, series: [
      { date: "2026-10-19", nav: null }, { date: "2026-10-20", nav: 1105 },
    ] });
  });

  it("does not call a disappearing account a loss or carry its old value forward", () => {
    expect(canonicalLiveEquitySnapshots([
      row("a", "2026-10-19", 100), row("b", "2026-10-19", 1000), row("a", "2026-10-20", 105),
    ], "us", ["a", "b"]).series).toEqual([
      { date: "2026-10-19", nav: 1100 }, { date: "2026-10-20", nav: null },
    ]);
  });

  it("respects exact account selection including an explicitly empty selection", () => {
    const rows = [row("a", "2026-10-19", 100), row("b", "2026-10-19", 1000)];
    expect(canonicalLiveEquitySnapshots(rows, "us", ["a"]).series).toEqual([{ date: "2026-10-19", nav: 100 }]);
    expect(canonicalLiveEquitySnapshots(rows, "us", []).series).toEqual([]);
    expect(canonicalLiveEquitySnapshots(rows, "us", ["missing"]).series).toEqual([]);
  });

  it("keeps markets/currencies separate and accepts only US legacy-null market rows", () => {
    const rows = [row("a", "2026-10-19", 100, { market: null, currency: null }),
      row("in", "2026-10-19", 100000, { market: "india", currency: "INR" }),
      row("bad", "2026-10-19", 1e6, { currency: "INR" })];
    expect(canonicalLiveEquitySnapshots(rows, "us").series).toEqual([{ date: "2026-10-19", nav: 100 }]);
    expect(canonicalLiveEquitySnapshots(rows, "india").series).toEqual([{ date: "2026-10-19", nav: 100000 }]);
  });

  it("treats missing or invalid equity as missing, not zero; real zero accounts are allowed", () => {
    const good = [row("a", "2026-10-19", 0), row("b", "2026-10-19", 100)];
    expect(canonicalLiveEquitySnapshots(good, "us").series[0].nav).toBe(100);
    for (const equity of [null, NaN, -1]) {
      expect(canonicalLiveEquitySnapshots([row("a", "2026-10-19", equity)], "us")).toMatchObject({
        invalidRows: 1, series: [{ date: "2026-10-19", nav: null }],
      });
    }
  });

  it("chooses the latest duplicate snapshot, rather than summing it twice", () => {
    expect(canonicalLiveEquitySnapshots([
      row("a", "2026-10-19", 100, { created_at: "2026-10-19T12:00:00Z" }),
      row("a", "2026-10-19", 105, { created_at: "2026-10-19T20:00:00Z" }),
    ], "us").series[0].nav).toBe(105);
  });

  it("does not draw a continuous portfolio line across absent live sessions", () => {
    const window = buildBenchmarkWindow([
      { date: "2026-10-19", nav: 100, bench_nav: 200 },
      { date: "2026-10-20", nav: null, bench_nav: 202 },
      { date: "2026-10-21", nav: 105, bench_nav: 204 },
    ], null, { preservePortfolioGaps: true });
    expect(window.points[1]).toEqual({ date: "2026-10-20", portfolio: null, bench: 1 });
    expect(window.matchedPortfolioReturnPct).toBe(5);
    expect(window.benchReturnPct).toBe(2);
  });
});

describe("live chart is the shared comparator, not fabricated historical performance", () => {
  it("reuses the paper chart with explicit live scope for both markets", () => {
    const wrapper = readFileSync("components/dashboard/LivePerformanceChart.tsx", "utf8");
    expect(wrapper).toContain('<BenchmarkPerformanceChart market={market} book="live"');
    expect(wrapper).not.toContain("AreaChart");
    const route = readFileSync("app/api/live-portfolio/performance/route.ts", "utf8");
    expect(route).toContain('url.searchParams.set("book", "live")');
    expect(route).not.toContain("paper_performance");
    expect(route).not.toContain("fetchDailySeries");
  });

  it("withholds live alpha, labels flow contamination, and preserves chart gaps", () => {
    const chart = readFileSync("components/dashboard/BenchmarkPerformanceChart.tsx", "utf8");
    expect(chart).toContain("!isLive && delta != null");
    expect(chart).toContain("Not cash-flow-adjusted");
    expect(chart).toContain("Trading outperformance not calculated");
    expect(chart).toContain('preservePortfolioGaps: isLive');
    expect(chart).toContain('connectNulls={false}');
    expect(chart).toContain("accounts=${encodeURIComponent(accountKey)}");
  });
});
