export type DisplayBenchmark = {
  id: string;
  label: string;
  symbol: string | null;
  provider_symbol: string | null;
  is_primary: boolean;
};

export type PortfolioLevel = { date: string; nav: number | null };
export type BenchmarkLevel = { date: string; close: number | null };

export type BenchmarkFreshness = {
  status: "ok" | "stale" | "unavailable";
  latestPortfolioDate: string | null;
  latestBenchmarkDate: string | null;
  missingPortfolioSessions: number;
};

/**
 * A comparator with old rows is not a healthy comparator.  Count the actual
 * paper-book sessions after its last usable level; this is market-calendar
 * safe because it uses the portfolio's recorded sessions, not calendar days.
 */
export function benchmarkFreshness(
  portfolio: PortfolioLevel[],
  benchmark: BenchmarkLevel[],
): BenchmarkFreshness {
  const portfolioDates = portfolio
    .filter((row) => row.nav != null && Number.isFinite(Number(row.nav)))
    .map((row) => row.date.slice(0, 10))
    .sort();
  const benchmarkDates = benchmark
    .filter((row) => row.close != null && Number.isFinite(Number(row.close)))
    .map((row) => row.date.slice(0, 10))
    .sort();
  const latestPortfolioDate = portfolioDates.at(-1) ?? null;
  const latestBenchmarkDate = benchmarkDates.at(-1) ?? null;
  if (!latestBenchmarkDate) return { status: "unavailable", latestPortfolioDate, latestBenchmarkDate: null, missingPortfolioSessions: portfolioDates.length };
  const missingPortfolioSessions = portfolioDates.filter((date) => date > latestBenchmarkDate).length;
  return {
    status: missingPortfolioSessions ? "stale" : "ok",
    latestPortfolioDate,
    latestBenchmarkDate,
    missingPortfolioSessions,
  };
}

/**
 * A display preference never changes `benchmarks.is_primary`. Requested values
 * win for the current request, then the owner's saved preference, then the
 * governed primary benchmark, with the first enabled row as a final UI fallback.
 */
export function selectDisplayBenchmark(
  benchmarks: DisplayBenchmark[],
  requestedId?: string | null,
  storedId?: string | null,
): DisplayBenchmark | null {
  if (!benchmarks.length) return null;
  return benchmarks.find((b) => b.id === requestedId)
    ?? benchmarks.find((b) => b.id === storedId)
    ?? benchmarks.find((b) => b.is_primary)
    ?? benchmarks[0];
}

/** Join only by exact market session. Missing benchmark levels stay explicit. */
export function mergePortfolioBenchmarkSeries(
  portfolio: PortfolioLevel[],
  benchmark: BenchmarkLevel[],
): Array<{ date: string; nav: number | null; bench_nav: number | null }> {
  const benchmarkByDate = new Map(
    benchmark
      .filter((row) => row.close != null && Number.isFinite(Number(row.close)))
      .map((row) => [row.date.slice(0, 10), Number(row.close)]),
  );
  return portfolio.map((row) => {
    const date = row.date.slice(0, 10);
    return {
      date,
      nav: row.nav == null || !Number.isFinite(Number(row.nav)) ? null : Number(row.nav),
      bench_nav: benchmarkByDate.get(date) ?? null,
    };
  });
}
