const TRADING_DAYS = 252;

export const BENCHMARK_HORIZONS = ["1W", "1M", "3M", "YTD", "1Y"] as const;
export type BenchmarkHorizon = typeof BENCHMARK_HORIZONS[number];
export type ScorecardStatus =
  | "ok"
  | "insufficient_data"
  | "benchmark_unpriceable"
  | "book_series_missing"
  | "currency_mismatch"
  | "stale_series";

export interface LevelPoint {
  date: string;
  level: number | null;
}

export interface BenchmarkConfig {
  id: string;
  market: "us" | "india";
  label: string;
  symbol: string | null;
  provider_symbol: string | null;
  currency: "USD" | "INR";
  is_primary: boolean;
}

export interface BenchmarkScorecardRow {
  market: "us" | "india";
  currency: "USD" | "INR";
  book: "paper" | "live";
  book_scope: string;
  benchmark_id: string;
  benchmark_symbol: string;
  is_primary_snapshot: boolean;
  horizon: BenchmarkHorizon;
  as_of: string;
  window_start: string | null;
  window_end: string | null;
  portfolio_return_pct: number | null;
  bench_return_pct: number | null;
  excess_return_pct: number | null;
  daily_excess_mean_pct: number | null;
  tracking_error_daily_pct: number | null;
  info_ratio: number | null;
  n_observations: number;
  n_return_days: number;
  coverage_pct: number | null;
  confidence: "insufficient" | "low" | "medium" | "high";
  status: ScorecardStatus;
  missing_reason: string | null;
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function sampleStdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function horizonStart(asOf: string, horizon: BenchmarkHorizon): string {
  const d = new Date(`${asOf}T00:00:00.000Z`);
  if (horizon === "YTD") return `${d.getUTCFullYear()}-01-01`;
  const days = horizon === "1W" ? 7 : horizon === "1M" ? 30 : horizon === "3M" ? 90 : 365;
  d.setUTCDate(d.getUTCDate() - days);
  return isoDate(d);
}

function expectedTradingDays(start: string, end: string): number {
  const s = new Date(`${start}T00:00:00.000Z`).getTime();
  const e = new Date(`${end}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return 0;
  const calendarDays = Math.floor((e - s) / 86400000) + 1;
  return Math.max(1, Math.round(calendarDays * 5 / 7));
}

function displayReturnFloor(horizon: BenchmarkHorizon, asOf: string): number {
  if (horizon === "1W") return 4;
  if (horizon === "1M") return 15;
  if (horizon === "3M") return 45;
  if (horizon === "1Y") return 120;
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  return Math.max(1, Math.min(20, expectedTradingDays(yearStart, asOf) - 1));
}

function confidenceFor(returnDays: number, coveragePct: number | null): BenchmarkScorecardRow["confidence"] {
  if (returnDays < 15 || coveragePct == null || coveragePct < 50) return "insufficient";
  if (returnDays >= 180 && coveragePct >= 80) return "high";
  if (returnDays >= 60 && coveragePct >= 70) return "medium";
  return "low";
}

function cleanSeries(rows: LevelPoint[]): LevelPoint[] {
  return rows
    .map((r) => ({ date: String(r.date).slice(0, 10), level: finiteNumber(r.level) }))
    .filter((r): r is { date: string; level: number } => !!r.date && r.level != null && r.level > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function computeBenchmarkScorecardRow(args: {
  market: "us" | "india";
  currency: "USD" | "INR";
  book: "paper" | "live";
  bookScope: string;
  benchmark: BenchmarkConfig;
  horizon: BenchmarkHorizon;
  asOf: string;
  portfolio: LevelPoint[];
  benchmarkLevels: LevelPoint[];
  unavailableStatus?: ScorecardStatus;
  missingReason?: string;
}): BenchmarkScorecardRow {
  const benchmarkSymbol = args.benchmark.symbol ?? args.benchmark.provider_symbol ?? args.benchmark.label;
  const base = {
    market: args.market,
    currency: args.currency,
    book: args.book,
    book_scope: args.bookScope,
    benchmark_id: args.benchmark.id,
    benchmark_symbol: benchmarkSymbol,
    is_primary_snapshot: args.benchmark.is_primary,
    horizon: args.horizon,
    as_of: args.asOf,
  };

  const empty = (
    status: ScorecardStatus,
    missingReason: string,
  ): BenchmarkScorecardRow => ({
    ...base,
    window_start: null,
    window_end: null,
    portfolio_return_pct: null,
    bench_return_pct: null,
    excess_return_pct: null,
    daily_excess_mean_pct: null,
    tracking_error_daily_pct: null,
    info_ratio: null,
    n_observations: 0,
    n_return_days: 0,
    coverage_pct: null,
    confidence: "insufficient",
    status,
    missing_reason: missingReason,
  });

  if (args.benchmark.currency !== args.currency) {
    return empty("currency_mismatch", `Benchmark ${benchmarkSymbol} is ${args.benchmark.currency}, book is ${args.currency}`);
  }
  if (args.unavailableStatus) {
    return empty(args.unavailableStatus, args.missingReason ?? args.unavailableStatus);
  }

  const start = horizonStart(args.asOf, args.horizon);
  const portfolio = cleanSeries(args.portfolio).filter((p) => p.date >= start && p.date <= args.asOf);
  const bench = cleanSeries(args.benchmarkLevels).filter((p) => p.date >= start && p.date <= args.asOf);
  if (portfolio.length === 0) return empty("book_series_missing", "No portfolio levels in horizon window");
  if (bench.length === 0) return empty("benchmark_unpriceable", "No benchmark levels in horizon window");

  const pByDate = new Map(portfolio.map((p) => [p.date, p.level]));
  const joined = bench
    .map((b) => ({ date: b.date, portfolio: pByDate.get(b.date), benchmark: b.level }))
    .filter((r): r is { date: string; portfolio: number; benchmark: number } => r.portfolio != null && r.benchmark != null && r.benchmark > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const nObservations = joined.length;
  const nReturnDays = Math.max(0, nObservations - 1);
  const expected = expectedTradingDays(start, args.asOf);
  const coveragePct = expected > 0 ? (nObservations / expected) * 100 : null;
  const confidence = confidenceFor(nReturnDays, coveragePct);
  const floor = displayReturnFloor(args.horizon, args.asOf);

  if (nReturnDays < floor) {
    return {
      ...empty("insufficient_data", `Need ${floor} return days for ${args.horizon}; have ${nReturnDays}`),
      n_observations: nObservations,
      n_return_days: nReturnDays,
      coverage_pct: coveragePct,
      confidence,
      window_start: joined[0]?.date ?? null,
      window_end: joined[joined.length - 1]?.date ?? null,
    };
  }

  const first = joined[0];
  const last = joined[joined.length - 1];
  const portfolioReturnPct = (last.portfolio / first.portfolio - 1) * 100;
  const benchReturnPct = (last.benchmark / first.benchmark - 1) * 100;
  const dailyExcessPct: number[] = [];
  for (let i = 1; i < joined.length; i++) {
    const prev = joined[i - 1];
    const cur = joined[i];
    const pRet = (cur.portfolio / prev.portfolio - 1) * 100;
    const bRet = (cur.benchmark / prev.benchmark - 1) * 100;
    if (Number.isFinite(pRet) && Number.isFinite(bRet)) dailyExcessPct.push(pRet - bRet);
  }

  const te = sampleStdev(dailyExcessPct);
  const dailyMean = mean(dailyExcessPct);
  const infoRatio = te > 0 ? (dailyMean / te) * Math.sqrt(TRADING_DAYS) : null;

  return {
    ...base,
    window_start: first.date,
    window_end: last.date,
    portfolio_return_pct: portfolioReturnPct,
    bench_return_pct: benchReturnPct,
    excess_return_pct: portfolioReturnPct - benchReturnPct,
    daily_excess_mean_pct: dailyMean,
    tracking_error_daily_pct: te > 0 ? te : null,
    info_ratio: infoRatio != null && Number.isFinite(infoRatio) ? infoRatio : null,
    n_observations: nObservations,
    n_return_days: dailyExcessPct.length,
    coverage_pct: coveragePct,
    confidence: infoRatio == null ? "insufficient" : confidence,
    status: infoRatio == null ? "insufficient_data" : "ok",
    missing_reason: infoRatio == null ? "Tracking error is zero or unavailable" : null,
  };
}

export function latestAsOf(rows: LevelPoint[]): string {
  const clean = cleanSeries(rows);
  return clean[clean.length - 1]?.date ?? isoDate(new Date());
}
