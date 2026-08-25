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
  /** Book symbols skipped for want of overlapping history. */
  skipped: string[];
  reason: string;
  thresholds: { maxAvgCorrToBook: number; maxSinglePairCorr: number; minSharedSessions: number };
}

/** A single hot pair is the failure mode an average cannot see (EOG/OXY 0.845). */
export const MAX_SINGLE_PAIR_CORR = 0.7;
/** Whole-book crowding. */
export const MAX_AVG_CORR_TO_BOOK = 0.5;
/** Below this, a correlation estimate is noise, not evidence. */
export const MIN_SHARED_SESSIONS = 30;

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
      worstPairSymbol: null, pairsMeasured: 0, skipped: [...input.book],
      reason: `no captured return history for ${input.candidate} — correlation unmeasurable, NOT assumed independent` };
  }

  const corrs: Array<{ symbol: string; corr: number }> = [];
  const skipped: string[] = [];
  for (const held of input.book) {
    if (held === input.candidate) continue;
    const series = input.returns[held];
    if (!series) { skipped.push(held); continue; }
    const { a, b } = alignedPair(candidateSeries, series);
    if (a.length < minShared) { skipped.push(held); continue; }
    const c = pearson(a, b);
    if (c === null) { skipped.push(held); continue; }
    corrs.push({ symbol: held, corr: c });
  }

  if (corrs.length === 0) {
    return { ...base, verdict: "unmeasurable", avgCorrToBook: null, maxCorrToBook: null,
      worstPairSymbol: null, pairsMeasured: 0, skipped,
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
): Promise<Record<string, ShadowReturnSeries>> {
  if (symbols.length === 0) return {};
  try {
    const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
    const { data, error } = await svc
      .from("symbol_daily_returns")
      .select("symbol, session_date, simple_return, available_at")
      .eq("market", market)
      .in("symbol", symbols as string[])
      .gte("session_date", since)
      .not("simple_return", "is", null)
      .order("available_at", { ascending: false })
      .limit(20000);
    if (error) return {};
    const out: Record<string, Record<string, number>> = {};
    const seen = new Set<string>();
    for (const row of (data ?? []) as any[]) {
      const sym = String(row.symbol);
      const date = String(row.session_date).slice(0, 10);
      const key = `${sym}|${date}`;
      if (seen.has(key)) continue;      // newest available_at already taken
      seen.add(key);
      const v = Number(row.simple_return);
      if (!Number.isFinite(v)) continue;
      (out[sym] ??= {})[date] = v;
    }
    return out;
  } catch {
    return {};
  }
}
