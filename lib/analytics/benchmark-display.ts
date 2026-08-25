export type DisplayBenchmark = {
  id: string;
  label: string;
  symbol: string | null;
  provider_symbol: string | null;
  is_primary: boolean;
};

export type PortfolioLevel = { date: string; nav: number | null };
export type BenchmarkLevel = { date: string; close: number | null };

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
