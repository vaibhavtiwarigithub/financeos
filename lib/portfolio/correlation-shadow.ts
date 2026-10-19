// Correlation-aware construction — SHADOW ONLY.
//
// WHAT THIS ANSWERS. `lib/portfolio/constructor.ts` carries a
// `maxAvgPairwiseCorr` limit that has never operated: every call site passes
// `beta: null`, no candidate-to-book correlation is available at entry, and
// `strategy_config.max_avg_pairwise_corr` is NULL in production. Before wiring a
// real correlation gate into sizing, the question worth answering is empirical:
// *would it have denied anything, and were those denials right?*
//
// So this computes the verdict a correlation gate WOULD reach and records it.
// It denies nothing.
//
// 🚨 BOUNDARY — MEASURE ONLY.
// No export here may be read by sizing, eligibility, ordering, or exits. The
// only consumer is a fail-soft shadow log. `tests/correlation-shadow.test.ts`
// pins that boundary; breaking it fails the suite.
//
// EVIDENCE THAT SHAPED THE THRESHOLDS (measured 2026-08-24 over 123 shared
// sessions, 36 pairs across the 10-name US book):
//   average pairwise correlation  0.048
//   max pair                      0.845  (EOG/OXY — two oil & gas E&Ps)
//   next highest                  0.437
//   pairs > 0.6                   1 of 36
//   negative pairs                16 of 36
// The book is NOT concentrated on average; the single real cluster is one
// duplicated energy bet. A useful gate therefore has to catch a SINGLE hot pair,
// which an average-only rule cannot do — 0.845 against a book of nine barely
// moves the mean. Hence two rules, and the pair rule is the one expected to bind.
//
// Thresholds are predeclared HERE, before any outcome is attached to a verdict.

export interface ShadowReturnSeries {
  /** session_date -> simple_return. One entry per session. */
  readonly [sessionDate: string]: number;
}

export interface CorrelationShadowInput {
  candidate: string;
  /** Symbols already held in the same market pool. */
  book: readonly string[];
  /** Daily returns keyed by symbol. Missing symbol = no history captured. */
  returns: Readonly<Record<string, ShadowReturnSeries>>;
  minSharedSessions?: number;
  maxAvgCorrToBook?: number;
  maxSinglePairCorr?: number;
}

export interface CorrelationShadowVerdict {
  verdict: "would_allow" | "would_deny" | "unmeasurable";
  candidate: string;
  avgCorrToBook: number | null;
  maxCorrToBook: number | null;
  worstPairSymbol: string | null;
  pairsMeasured: number;
  averageShrinkage: number | null;
  /** Book symbols skipped for want of overlapping history. */
  skipped: string[];
  reason: string;
  thresholds: { maxAvgCorrToBook: number; maxSinglePairCorr: number; minSharedSessions: number };
}

export interface PointInTimeReturnPanel {
  market: "us" | "india";
  decisionAt: string;
  priceBasis: "adjusted_close" | "raw_close" | null;
  returns: Readonly<Record<string, ShadowReturnSeries>>;
  commonSessions: readonly string[];
  coverage: Readonly<Record<string, { sessions: number; firstSession: string | null; lastSession: string | null }>>;
  evidenceFingerprint: string | null;
}

export interface CovarianceSizingShadow {
  state: "measured" | "unmeasurable";
  reason: string | null;
  priceBasis: "adjusted_close" | "raw_close" | null;
  commonSessions: number;
  firstSession: string | null;
  lastSession: string | null;
  shrinkage: number | null;
  baselineSizePct: number;
  counterfactualSizePct: number | null;
  baselineDailyVolPct: number | null;
  counterfactualDailyVolPct: number | null;
  maxPortfolioDailyVolPct: number;
  sizeReductionPct: number | null;
  symbols: string[];
  evidenceFingerprint: string | null;
}

/** A single hot pair is the failure mode an average cannot see (EOG/OXY 0.845). */
export const MAX_SINGLE_PAIR_CORR = 0.7;
/** Whole-book crowding. */
export const MAX_AVG_CORR_TO_BOOK = 0.5;
/** Below this, a correlation estimate is noise, not evidence. */
export const MIN_SHARED_SESSIONS = 60;
export const MIN_COVARIANCE_SESSIONS = 60;

export function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  // A flat series has no correlation with anything. Returning 0 would read as
  // "independent", which is a claim; null is the honest answer.
  if (da <= 0 || db <= 0) return null;
  return num / Math.sqrt(da * db);
}

/**
 * A simple, deterministic diagonal-target covariance shrinker. The empirical
 * covariance from a common complete-case panel is PSD; its convex combination
 * with its diagonal remains PSD. Shrinkage rises with portfolio dimension and
 * falls with sample size. This is a conservative diagnostic, not a learned
 * parameter and not an expected-return optimizer.
 */
export function covarianceShrinkage(sessions: number, dimensions: number): number {
  if (!Number.isFinite(sessions) || !Number.isFinite(dimensions) || sessions <= 0 || dimensions <= 0) return 1;
  return Math.max(0.1, Math.min(0.5, dimensions / (sessions + dimensions)));
}

function sampleCovariance(columns: readonly number[][]): number[][] | null {
  const n = columns[0]?.length ?? 0;
  if (n < 2 || columns.some((column) => column.length !== n)) return null;
  const means = columns.map((column) => column.reduce((sum, value) => sum + value, 0) / n);
  return columns.map((column, i) => columns.map((other, j) => {
    let sum = 0;
    for (let t = 0; t < n; t++) sum += (column[t] - means[i]) * (other[t] - means[j]);
    return sum / (n - 1);
  }));
}

function portfolioVolPct(weightsPct: readonly number[], covariance: readonly (readonly number[])[]): number | null {
  if (weightsPct.length !== covariance.length || covariance.some((row) => row.length !== weightsPct.length)) return null;
  const weights = weightsPct.map((value) => value / 100);
  let variance = 0;
  for (let i = 0; i < weights.length; i++) {
    for (let j = 0; j < weights.length; j++) variance += weights[i] * covariance[i][j] * weights[j];
  }
  if (!Number.isFinite(variance) || variance < -1e-12) return null;
  return Math.sqrt(Math.max(0, variance)) * 100;
}

/**
 * Size-only covariance counterfactual against the existing constructor's size.
 * It is strictly subtractive, has no expected-return input, and abstains unless
 * every current holding and candidate share >=60 PIT sessions on one price basis.
 */
export function computeCovarianceSizingShadow(input: {
  candidate: string;
  book: readonly { symbol: string; valuePct: number }[];
  returns: Readonly<Record<string, ShadowReturnSeries>>;
  priceBasis: "adjusted_close" | "raw_close" | null;
  commonSessions?: readonly string[];
  minSharedSessions?: number;
  baselineSizePct: number;
  maxPortfolioDailyVolPct: number;
  evidenceFingerprint?: string | null;
}): CovarianceSizingShadow {
  const symbols = [...new Set([...input.book.map((item) => item.symbol), input.candidate])].sort();
  const dates = (input.commonSessions?.length
    ? [...input.commonSessions]
    : Object.keys(input.returns[input.candidate] ?? {}).filter((date) => symbols.every((symbol) => input.returns[symbol]?.[date] !== undefined)))
    .sort();
  const minSessions = input.minSharedSessions ?? MIN_COVARIANCE_SESSIONS;
  const base = {
    priceBasis: input.priceBasis,
    commonSessions: dates.length,
    firstSession: dates[0] ?? null,
    lastSession: dates.at(-1) ?? null,
    baselineSizePct: input.baselineSizePct,
    maxPortfolioDailyVolPct: input.maxPortfolioDailyVolPct,
    symbols,
    evidenceFingerprint: input.evidenceFingerprint ?? null,
  };
  const unavailable = (reason: string): CovarianceSizingShadow => ({
    ...base, state: "unmeasurable", reason, shrinkage: null,
    counterfactualSizePct: null, baselineDailyVolPct: null,
    counterfactualDailyVolPct: null, sizeReductionPct: null,
  });
  if (!input.priceBasis) return unavailable("no_common_price_basis");
  if (!Number.isFinite(input.baselineSizePct) || input.baselineSizePct < 0) return unavailable("invalid_baseline_size");
  if (!Number.isFinite(input.maxPortfolioDailyVolPct) || input.maxPortfolioDailyVolPct <= 0) return unavailable("invalid_volatility_budget");
  if (dates.length < minSessions) return unavailable(`complete_common_history_${dates.length}_below_${minSessions}`);
  if (symbols.some((symbol) => dates.some((date) => !Number.isFinite(input.returns[symbol]?.[date])))) {
    return unavailable("incomplete_common_return_panel");
  }

  const empirical = sampleCovariance(symbols.map((symbol) => dates.map((date) => input.returns[symbol][date])));
  if (!empirical || empirical.some((row) => row.some((value) => !Number.isFinite(value)))) return unavailable("invalid_covariance_matrix");
  const shrinkage = covarianceShrinkage(dates.length, symbols.length);
  const covariance = empirical.map((row, i) => row.map((value, j) => i === j ? value : value * (1 - shrinkage)));
  const candidateIndex = symbols.indexOf(input.candidate);
  const bookWeights = symbols.map((symbol) => input.book
    .filter((item) => item.symbol === symbol)
    .reduce((sum, item) => sum + item.valuePct, 0));
  const baselineWeights = [...bookWeights];
  baselineWeights[candidateIndex] += input.baselineSizePct;
  const baselineVol = portfolioVolPct(baselineWeights, covariance);
  if (baselineVol == null) return unavailable("portfolio_variance_not_finite");

  let counterfactualSize = input.baselineSizePct;
  let counterfactualReason: string | null = null;
  if (baselineVol > input.maxPortfolioDailyVolPct) {
    const bookVol = portfolioVolPct(bookWeights, covariance);
    // Adding a candidate cannot repair an already-over-budget book in this
    // subtractive shadow. Report zero as its counterfactual, never upsize it.
    if (bookVol == null || bookVol > input.maxPortfolioDailyVolPct) {
      counterfactualSize = 0;
      counterfactualReason = "existing_book_already_over_budget_candidate_counterfactual_zero";
    } else {
      let lo = 0, hi = input.baselineSizePct;
      for (let iteration = 0; iteration < 48; iteration++) {
        const mid = (lo + hi) / 2;
        const trial = [...bookWeights];
        trial[candidateIndex] += mid;
        const vol = portfolioVolPct(trial, covariance);
        if (vol != null && vol <= input.maxPortfolioDailyVolPct) lo = mid;
        else hi = mid;
      }
      counterfactualSize = lo;
    }
  }
  const cfWeights = [...bookWeights];
  cfWeights[candidateIndex] += counterfactualSize;
  const cfVol = portfolioVolPct(cfWeights, covariance);
  if (cfVol == null) return unavailable("counterfactual_variance_not_finite");
  const roundedSize = Math.min(input.baselineSizePct, Math.round(counterfactualSize * 10000) / 10000);
  return {
    ...base, state: "measured", reason: counterfactualReason, shrinkage,
    counterfactualSizePct: roundedSize,
    baselineDailyVolPct: baselineVol,
    counterfactualDailyVolPct: cfVol,
    sizeReductionPct: Math.max(0, input.baselineSizePct - roundedSize),
  };
}

/** Returns for the sessions BOTH series cover, aligned by date. */
function alignedPair(x: ShadowReturnSeries, y: ShadowReturnSeries): { a: number[]; b: number[] } {
  const a: number[] = [], b: number[] = [];
  for (const date of Object.keys(x)) {
    const vy = y[date];
    if (vy === undefined) continue;
    const vx = x[date];
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) continue;
    a.push(vx); b.push(vy);
  }
  return { a, b };
}

export function computeCorrelationShadow(input: CorrelationShadowInput): CorrelationShadowVerdict {
  const minShared = input.minSharedSessions ?? MIN_SHARED_SESSIONS;
  const capAvg = input.maxAvgCorrToBook ?? MAX_AVG_CORR_TO_BOOK;
  const capPair = input.maxSinglePairCorr ?? MAX_SINGLE_PAIR_CORR;
  const thresholds = { maxAvgCorrToBook: capAvg, maxSinglePairCorr: capPair, minSharedSessions: minShared };
  const base = { candidate: input.candidate, thresholds };

  const candidateSeries = input.returns[input.candidate];
  if (!candidateSeries || Object.keys(candidateSeries).length === 0) {
    // A symbol with no captured history must NOT read as uncorrelated. SKHY sits
    // in the live book with zero return days and would sail through any gate
    // that treats absent data as a pass.
    return { ...base, verdict: "unmeasurable", avgCorrToBook: null, maxCorrToBook: null,
      worstPairSymbol: null, pairsMeasured: 0, averageShrinkage: null, skipped: [...input.book],
      reason: `no captured return history for ${input.candidate} — correlation unmeasurable, NOT assumed independent` };
  }

  const corrs: Array<{ symbol: string; corr: number; shrinkage: number }> = [];
  const skipped: string[] = [];
  for (const held of input.book) {
    if (held === input.candidate) continue;
    const series = input.returns[held];
    if (!series) { skipped.push(held); continue; }
    const { a, b } = alignedPair(candidateSeries, series);
    if (a.length < minShared) { skipped.push(held); continue; }
    const c = pearson(a, b);
    if (c === null) { skipped.push(held); continue; }
    const shrinkage = covarianceShrinkage(a.length, input.book.length + 1);
    corrs.push({ symbol: held, corr: c * (1 - shrinkage), shrinkage });
  }

  if (corrs.length === 0) {
    return { ...base, verdict: "unmeasurable", avgCorrToBook: null, maxCorrToBook: null,
      worstPairSymbol: null, pairsMeasured: 0, averageShrinkage: null, skipped,
      reason: `no book symbol shared >= ${minShared} sessions with ${input.candidate}` };
  }

  const avg = corrs.reduce((s, r) => s + r.corr, 0) / corrs.length;
  const worst = corrs.reduce((w, r) => (r.corr > w.corr ? r : w), corrs[0]);
  const breaches: string[] = [];
  if (worst.corr > capPair) breaches.push(`pair ${input.candidate}/${worst.symbol} ${worst.corr.toFixed(3)} > ${capPair}`);
  if (avg > capAvg) breaches.push(`avg-to-book ${avg.toFixed(3)} > ${capAvg}`);

  return {
    ...base,
    verdict: breaches.length > 0 ? "would_deny" : "would_allow",
    avgCorrToBook: avg,
    maxCorrToBook: worst.corr,
    worstPairSymbol: worst.symbol,
    pairsMeasured: corrs.length,
    averageShrinkage: corrs.reduce((sum, pair) => sum + pair.shrinkage, 0) / corrs.length,
    skipped,
    reason: breaches.length > 0
      ? `WOULD DENY (shadow only): ${breaches.join("; ")}`
      : `would allow: avg ${avg.toFixed(3)} <= ${capAvg}, worst pair ${worst.symbol} ${worst.corr.toFixed(3)} <= ${capPair}`,
  };
}

// ── Loader (impure) ─────────────────────────────────────────────────────────
// Reads captured daily returns. Kept below the pure core so the scoring logic
// above stays unit-testable without a database.

/**
 * Daily returns for the given symbols from `symbol_daily_returns`.
 *
 * De-duplicated per (symbol, session_date): the capture hook is fail-soft and
 * piggybacks on research runs, so one session can hold several rows for a
 * symbol. The newest `available_at` wins, which is also the point-in-time
 * correct choice.
 *
 * Returns `{}` on any error — a shadow measurement must never break a fill.
 */
export async function loadShadowReturns(
  svc: any,
  market: "us" | "india",
  symbols: readonly string[],
  lookbackDays = 180,
  decisionAt = new Date(),
): Promise<Record<string, ShadowReturnSeries>> {
  return (await loadPointInTimeReturnPanel(svc, market, symbols, decisionAt, lookbackDays)).returns as Record<string, ShadowReturnSeries>;
}

function digestStrings(values: readonly string[]): string {
  const input = values.join("|");
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) hash = Math.imul(hash ^ input.charCodeAt(i), 16777619);
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Load an auditable point-in-time return panel. Each date is represented by its
 * newest row known at decisionAt, and all symbols are forced onto one price
 * basis before any correlation or covariance is calculated.
 */
export async function loadPointInTimeReturnPanel(
  svc: any,
  market: "us" | "india",
  symbols: readonly string[],
  decisionAt = new Date(),
  lookbackDays = 180,
): Promise<PointInTimeReturnPanel> {
  const requested = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))].sort();
  const empty = (priceBasis: PointInTimeReturnPanel["priceBasis"] = null): PointInTimeReturnPanel => ({
    market, decisionAt: decisionAt.toISOString(), priceBasis, returns: {}, commonSessions: [], coverage: {}, evidenceFingerprint: null,
  });
  if (requested.length === 0) return empty();
  try {
    const since = new Date(decisionAt.getTime() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
    const { data, error } = await svc
      .from("symbol_daily_returns")
      .select("id,symbol,session_date,simple_return,available_at,price_basis,input_fingerprint")
      .eq("market", market)
      .in("symbol", requested)
      .gte("session_date", since)
      .lte("available_at", decisionAt.toISOString())
      .not("simple_return", "is", null)
      .order("available_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(20000);
    if (error) return empty();
    const byBasis = new Map<string, Map<string, Map<string, any>>>();
    for (const row of (data ?? []) as any[]) {
      const sym = String(row.symbol).trim().toUpperCase();
      const date = String(row.session_date).slice(0, 10);
      const basis = String(row.price_basis);
      if (basis !== "adjusted_close" && basis !== "raw_close") continue;
      const v = Number(row.simple_return);
      if (!Number.isFinite(v)) continue;
      const series = byBasis.get(basis) ?? new Map<string, Map<string, any>>();
      const symbolRows = series.get(sym) ?? new Map<string, any>();
      // Query order is newest first; later revisions for the same symbol/date
      // cannot overwrite the first row known by the decision cutoff.
      if (!symbolRows.has(date)) symbolRows.set(date, row);
      series.set(sym, symbolRows);
      byBasis.set(basis, series);
    }

    let selectedBasis: "adjusted_close" | "raw_close" | null = null;
    let selectedDates: string[] = [];
    let selectedRows: any[] = [];
    for (const basis of ["adjusted_close", "raw_close"] as const) {
      const series = byBasis.get(basis);
      if (!series) continue;
      const common = [...(series.get(requested[0])?.keys() ?? [])]
        .filter((date) => requested.every((symbol) => series.get(symbol)?.has(date)))
        .sort();
      if (common.length > selectedDates.length) {
        selectedBasis = basis;
        selectedDates = common;
        selectedRows = requested.flatMap((symbol) => common.map((date) => series.get(symbol)!.get(date)));
      }
    }
    if (!selectedBasis) return empty();

    const returns: Record<string, Record<string, number>> = {};
    const coverage: Record<string, { sessions: number; firstSession: string | null; lastSession: string | null }> = {};
    for (const symbol of requested) {
      const symbolRows = byBasis.get(selectedBasis)?.get(symbol);
      const symbolDates = [...(symbolRows?.keys() ?? [])].sort();
      returns[symbol] = Object.fromEntries(symbolDates.map((date) => [date, Number(symbolRows!.get(date).simple_return)]));
      coverage[symbol] = { sessions: symbolDates.length, firstSession: symbolDates[0] ?? null, lastSession: symbolDates.at(-1) ?? null };
    }
    const fingerprints = selectedRows.map((row) => `${row.symbol}:${row.session_date}:${row.input_fingerprint}`).sort();
    return {
      market, decisionAt: decisionAt.toISOString(), priceBasis: selectedBasis, returns,
      commonSessions: selectedDates, coverage, evidenceFingerprint: fingerprints.length ? digestStrings(fingerprints) : null,
    };
  } catch {
    return empty();
  }
}
