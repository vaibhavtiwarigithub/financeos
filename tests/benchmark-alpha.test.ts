import { describe, expect, it } from "vitest";
import { computeBenchmarkScorecardRow, horizonStart } from "@/lib/analytics/benchmark-alpha";

const benchmark = {
  id: "00000000-0000-0000-0000-000000000001",
  market: "us" as const,
  label: "VOO",
  symbol: "VOO",
  provider_symbol: "VOO",
  currency: "USD" as const,
  is_primary: true,
};

function series(start: string, n: number, base: number, step: number) {
  const out = [];
  const d = new Date(`${start}T00:00:00.000Z`);
  for (let i = 0; i < n; i++) {
    out.push({ date: d.toISOString().slice(0, 10), level: base + i * step });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("benchmark-alpha math", () => {
  it("computes common-window excess return and annualized daily information ratio", () => {
    const portfolio = series("2026-01-01", 70, 100, 1.2);
    const bench = series("2026-01-01", 70, 100, 0.8);
    const row = computeBenchmarkScorecardRow({
      market: "us",
      currency: "USD",
      book: "paper",
      bookScope: "market_paper_pool",
      benchmark,
      horizon: "1M",
      asOf: "2026-03-10",
      portfolio,
      benchmarkLevels: bench,
    });
    expect(row.status).toBe("ok");
    expect(row.excess_return_pct!).toBeGreaterThan(0);
    expect(row.info_ratio).not.toBeNull();
    expect(row.n_return_days).toBeGreaterThanOrEqual(15);
  });

  it("does not divide cumulative excess by daily tracking error", () => {
    const portfolio = series("2026-01-01", 70, 100, 1.2);
    const bench = series("2026-01-01", 70, 100, 0.5);
    const row = computeBenchmarkScorecardRow({
      market: "us",
      currency: "USD",
      book: "paper",
      bookScope: "market_paper_pool",
      benchmark,
      horizon: "1M",
      asOf: "2026-03-10",
      portfolio,
      benchmarkLevels: bench,
    });
    const wrongRatio = (row.excess_return_pct ?? 0) / (row.tracking_error_daily_pct ?? 1);
    expect(row.info_ratio).not.toBeCloseTo(wrongRatio, 2);
  });

  it("stores insufficient rows for short YTD windows", () => {
    const row = computeBenchmarkScorecardRow({
      market: "us",
      currency: "USD",
      book: "paper",
      bookScope: "market_paper_pool",
      benchmark,
      horizon: "YTD",
      asOf: "2026-01-03",
      portfolio: series("2026-01-01", 3, 100, 1),
      benchmarkLevels: series("2026-01-01", 3, 100, 1),
    });
    expect(row.status).toBe("insufficient_data");
    expect(row.info_ratio).toBeNull();
  });

  it("refuses a stale common endpoint instead of calling an old comparison current", () => {
    const row = computeBenchmarkScorecardRow({
      market: "us",
      currency: "USD",
      book: "paper",
      bookScope: "market_paper_pool",
      benchmark,
      horizon: "1M",
      asOf: "2026-03-10",
      portfolio: series("2026-01-01", 70, 100, 1),
      benchmarkLevels: series("2026-01-01", 62, 100, 1),
    });
    expect(row.status).toBe("stale_series");
    expect(row.window_end).toBe("2026-03-03");
    expect(row.excess_return_pct).toBeNull();
  });

  it("does not annualize a multi-session gap as one daily return", () => {
    const dates = ["2026-01-15", "2026-01-16", "2026-01-21", "2026-01-22", "2026-01-23"];
    const levels = dates.map((date, index) => ({ date, level: 100 + index }));
    const row = computeBenchmarkScorecardRow({
      market: "us", currency: "USD", book: "paper", bookScope: "market_paper_pool",
      benchmark, horizon: "1W", asOf: "2026-01-23", portfolio: levels, benchmarkLevels: levels,
    });
    // The 1W window starts on Friday; Fri -> Wed skips the eligible Tuesday
    // session. Only the two contiguous pairs count, so the four-day floor is
    // not met.
    expect(row.n_return_days).toBe(2);
    expect(row.status).toBe("insufficient_data");
  });

  it("rejects currency mismatches instead of computing cross-currency alpha", () => {
    const indiaBench = { ...benchmark, market: "india" as const, currency: "INR" as const, label: "NIFTY", symbol: "^NSEI", provider_symbol: "^NSEI" };
    const row = computeBenchmarkScorecardRow({
      market: "us",
      currency: "USD",
      book: "paper",
      bookScope: "market_paper_pool",
      benchmark: indiaBench,
      horizon: "1M",
      asOf: "2026-03-10",
      portfolio: series("2026-01-01", 70, 100, 1),
      benchmarkLevels: series("2026-01-01", 70, 100, 1),
    });
    expect(row.status).toBe("currency_mismatch");
  });

  it("computes expected horizon starts deterministically", () => {
    expect(horizonStart("2026-07-13", "YTD")).toBe("2026-01-01");
    expect(horizonStart("2026-07-13", "1W")).toBe("2026-07-06");
  });
});
