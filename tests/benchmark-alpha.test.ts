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
    const portfolio = [
      { date: "2026-01-01", level: 100 },
      { date: "2026-01-02", level: 102 },
      { date: "2026-01-03", level: 101 },
      { date: "2026-01-04", level: 104 },
      { date: "2026-01-05", level: 103 },
      { date: "2026-01-06", level: 106 },
      { date: "2026-01-07", level: 105 },
      { date: "2026-01-08", level: 108 },
      { date: "2026-01-09", level: 107 },
      { date: "2026-01-10", level: 110 },
      { date: "2026-01-11", level: 109 },
      { date: "2026-01-12", level: 112 },
      { date: "2026-01-13", level: 111 },
      { date: "2026-01-14", level: 114 },
      { date: "2026-01-15", level: 113 },
      { date: "2026-01-16", level: 116 },
      { date: "2026-01-17", level: 115 },
    ];
    const bench = series("2026-01-01", 17, 100, 0.5);
    const row = computeBenchmarkScorecardRow({
      market: "us",
      currency: "USD",
      book: "paper",
      bookScope: "market_paper_pool",
      benchmark,
      horizon: "1M",
      asOf: "2026-01-17",
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
