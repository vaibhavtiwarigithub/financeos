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
  /** RELATIVE only: does the comparator keep up with the book's own sessions? */
  status: "ok" | "stale" | "unavailable";
  latestPortfolioDate: string | null;
  latestBenchmarkDate: string | null;
  missingPortfolioSessions: number;
  /**
   * ABSOLUTE: are the ledgers level with the market calendar? `status` compares
   * the two ledgers to each other, so when BOTH stall it still reads "ok" —
   * exactly the failure an owner would report as "the chart is stuck". This
   * layer answers it against the exchange calendar instead.
   */
  pipeline: PipelineFreshness;
};

export type PipelineFreshness = {
  /** "current" — nothing further is due yet. "behind" — a closed session is missing. */
  state: "current" | "behind" | "unknown";
  /** Latest session whose close should already be recorded; null when unknown. */
  expectedSessionDate: string | null;
  /** Closed sessions recorded nowhere yet, counted from the expected session back. */
  portfolioBehind: boolean;
  benchmarkBehind: boolean;
  /** Why today adds no new point ("weekend", "market holiday", ...), else null. */
  closedReason: string | null;
  todayLocalYmd: string | null;
};

/**
 * A comparator with old rows is not a healthy comparator.  Count the actual
 * paper-book sessions after its last usable level; this is market-calendar
 * safe because it uses the portfolio's recorded sessions, not calendar days.
 */
export function benchmarkFreshness(
  portfolio: PortfolioLevel[],
  benchmark: BenchmarkLevel[],
  expected?: ExpectedSessionContext,
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
  const pipeline = pipelineFreshness(latestPortfolioDate, latestBenchmarkDate, expected);
  if (!latestBenchmarkDate) {
    return {
      status: "unavailable",
      latestPortfolioDate,
      latestBenchmarkDate: null,
      missingPortfolioSessions: portfolioDates.length,
      pipeline,
    };
  }
  const missingPortfolioSessions = portfolioDates.filter((date) => date > latestBenchmarkDate).length;
  return {
    status: missingPortfolioSessions ? "stale" : "ok",
    latestPortfolioDate,
    latestBenchmarkDate,
    missingPortfolioSessions,
    pipeline,
  };
}

/** Calendar facts the caller supplies; keeps this module free of clock/timezone work. */
export type ExpectedSessionContext = {
  expectedSessionDate: string | null;
  calendarSupported: boolean;
  closedReason: string | null;
  todayLocalYmd: string | null;
};

/**
 * Fail open, never loud: without a supported calendar the state is "unknown"
 * rather than a staleness claim the calendar cannot actually support.
 */
export function pipelineFreshness(
  latestPortfolioDate: string | null,
  latestBenchmarkDate: string | null,
  expected?: ExpectedSessionContext,
): PipelineFreshness {
  const expectedSessionDate = expected?.expectedSessionDate ?? null;
  const closedReason = expected?.closedReason ?? null;
  const todayLocalYmd = expected?.todayLocalYmd ?? null;
  if (!expected || !expected.calendarSupported || !expectedSessionDate) {
    return {
      state: "unknown",
      expectedSessionDate,
      portfolioBehind: false,
      benchmarkBehind: false,
      closedReason,
      todayLocalYmd,
    };
  }
  const portfolioBehind = !latestPortfolioDate || latestPortfolioDate < expectedSessionDate;
  const benchmarkBehind = !latestBenchmarkDate || latestBenchmarkDate < expectedSessionDate;
  return {
    state: portfolioBehind || benchmarkBehind ? "behind" : "current",
    expectedSessionDate,
    portfolioBehind,
    benchmarkBehind,
    closedReason,
    todayLocalYmd,
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
