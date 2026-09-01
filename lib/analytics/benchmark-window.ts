// Portfolio-vs-benchmark window arithmetic.
//
// Extracted from components/dashboard/BenchmarkPerformanceChart.tsx so the rule
// below is testable rather than living inside a useMemo.
//
// THE RULE: a portfolio's own return is a property of the portfolio. It must not
// change when the reader picks a different comparison benchmark.
//
// The bug this exists to prevent (fixed 2026-09-01): the chart filtered on
// `bench_nav != null` BEFORE choosing the rebase base, so a benchmark whose
// coverage started late — or ended early — silently moved the portfolio's base
// date. Measured on the US 1M window that day:
//
//   VOO   9 sessions, 2026-08-19..08-31   portfolio +1.345%
//   XLF   9 sessions, 2026-08-19..08-31   portfolio +1.345%
//   QQQ   8 sessions, 2026-08-19..08-28   portfolio +1.403%
//   XLK   4 sessions, 2026-08-19..08-24   portfolio +0.010%   (stale since 08-24)
//
// Same book, same requested window, three different answers — and XLK understated
// it by 134x purely because that benchmark had stopped updating.

export interface BenchmarkSeriesRow {
  date: string;
  nav: number | null;
  bench_nav: number | null;
}

export interface BenchmarkWindowPoint {
  date: string;
  portfolio: number | null;
  bench: number | null;
}

export interface BenchmarkWindow {
  points: BenchmarkWindowPoint[];
  /** Full-window portfolio return. Independent of which benchmark is selected. */
  portfolioReturnPct: number | null;
  /** Benchmark return over the OVERLAP only. */
  benchReturnPct: number | null;
  /** Portfolio minus benchmark, both measured over the overlap. */
  deltaPct: number | null;
  /** Set when the benchmark cannot cover the requested window. */
  truncation: { sessionsLost: number; until: string | null } | null;
}

export function pctChange(value: number, base: number): number {
  if (!base) return 0;
  return parseFloat((((value - base) / base) * 100).toFixed(3));
}

/**
 * Build the comparison window.
 *
 * `portfolioReturnPct` uses every row with a NAV in the window. The delta uses
 * only the overlap, because rebasing the portfolio from Monday against a
 * benchmark rebased from Wednesday is a fake relative return — that half of the
 * original reasoning was right and is kept.
 */
export function buildBenchmarkWindow(
  series: readonly BenchmarkSeriesRow[],
  cutoffMs: number | null,
): BenchmarkWindow {
  const inWindow = (r: BenchmarkSeriesRow) =>
    cutoffMs == null || new Date(r.date).getTime() >= cutoffMs;

  const portfolioRows = series.filter((r) => r.nav != null && inWindow(r));
  if (portfolioRows.length < 2) {
    return { points: [], portfolioReturnPct: null, benchReturnPct: null, deltaPct: null, truncation: null };
  }

  const navBase = Number(portfolioRows[0].nav);
  const portfolioReturnPct = pctChange(Number(portfolioRows[portfolioRows.length - 1].nav), navBase);

  const overlap = portfolioRows.filter((r) => r.bench_nav != null);
  const overlapNavBase = overlap.length ? Number(overlap[0].nav) : null;
  const overlapBenchBase = overlap.length ? Number(overlap[0].bench_nav) : null;

  const points: BenchmarkWindowPoint[] = portfolioRows.map((r) => ({
    date: r.date,
    portfolio: overlapNavBase != null
      ? pctChange(Number(r.nav), overlapNavBase)
      : pctChange(Number(r.nav), navBase),
    bench: r.bench_nav != null && overlapBenchBase != null
      ? pctChange(Number(r.bench_nav), overlapBenchBase)
      : null,
  }));

  let benchReturnPct: number | null = null;
  let deltaPct: number | null = null;
  if (overlap.length >= 2 && overlapNavBase != null && overlapBenchBase != null) {
    const last = overlap[overlap.length - 1];
    benchReturnPct = pctChange(Number(last.bench_nav), overlapBenchBase);
    const portfolioAtOverlapEnd = pctChange(Number(last.nav), overlapNavBase);
    deltaPct = parseFloat((portfolioAtOverlapEnd - benchReturnPct).toFixed(2));
  }

  const lastPortfolioDate = portfolioRows[portfolioRows.length - 1].date;
  const lastOverlapDate = overlap.length ? overlap[overlap.length - 1].date : null;
  const truncation =
    overlap.length === 0
      ? { sessionsLost: portfolioRows.length, until: null }
      : lastOverlapDate !== lastPortfolioDate || overlap.length !== portfolioRows.length
        ? { sessionsLost: portfolioRows.length - overlap.length, until: lastOverlapDate }
        : null;

  return { points, portfolioReturnPct, benchReturnPct, deltaPct, truncation };
}
