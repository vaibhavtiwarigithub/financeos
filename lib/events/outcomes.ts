// Event ledger step 2 — forward-outcome computation.
//
// Pure. Every anti-look-ahead decision this feature makes lives in this file so
// it can be tested without a database, a provider, or a clock.
//
// MEASUREMENT ONLY. Nothing here reaches a score, eligibility, size, entry,
// exit, promotion or broker decision. See features/event-ledger/.

export interface OhlcBar {
  date: string; // YYYY-MM-DD
  high: number;
  low: number;
  close: number;
}

export interface EventOutcome {
  entryDate: string;
  exitDate: string;
  sessionsUsed: number;
  fwdReturn: number;
  benchmarkReturn: number | null;
  /** Subject return minus benchmark return. Null when no benchmark aligned. */
  benchmarkNeutralReturn: number | null;
  /** Worst / best close-to-extreme move over the window, from the entry close. */
  maxAdverseExcursion: number;
  maxFavorableExcursion: number;
}

/**
 * Approximate UTC hour at which each market's cash session closes.
 *
 * This is what decides whether an event that happened at 17:20 UTC is tradable
 * on that day's close (US: 20:00 UTC, so yes) or only on the next session
 * (India: 10:00 UTC, so no). Getting this backwards is the difference between a
 * measurement and a look-ahead, which is why it is an explicit constant rather
 * than an implicit "next day" rule.
 *
 * Deliberately approximate: DST moves the US close between 20:00 and 21:00 UTC.
 * The ledger's own timestamps are mostly date-precision and are stamped 23:59Z,
 * which is after either value, so the ambiguity cannot flip an entry for those.
 * It could only matter for an intraday-cited event between 20:00 and 21:00 UTC —
 * and there the conservative reading (event lands after the close, enter next
 * session) is the one this constant produces.
 */
export const MARKET_CLOSE_UTC_HOUR: Record<string, number> = { us: 20, india: 10 };

export function marketCloseHour(market: string): number {
  return MARKET_CLOSE_UTC_HOUR[market] ?? 20;
}

/**
 * The first session whose CLOSE falls strictly after `occurredAt` — the only
 * session a measurement may start from.
 *
 * Anchoring on the close, not the date, is the whole point. An event announced
 * at 13:20 ET is tradable at that day's close; one announced after the bell is
 * not, and starting from the pre-announcement close would fold the market's
 * reaction INTO the "forward" return and make the pattern look prescient. The
 * ledger's date-precision rows are stamped 23:59Z precisely so this function
 * pushes them to the next session.
 *
 * Returns the index into `bars` (assumed ascending by date), or -1.
 */
export function entryIndex(bars: readonly OhlcBar[], occurredAt: string, market: string): number {
  const occurred = Date.parse(occurredAt);
  if (!Number.isFinite(occurred)) return -1;
  const closeHour = marketCloseHour(market);
  for (let i = 0; i < bars.length; i++) {
    const closeMs = Date.parse(`${bars[i].date}T${String(closeHour).padStart(2, "0")}:00:00.000Z`);
    if (Number.isFinite(closeMs) && closeMs > occurred) return i;
  }
  return -1;
}

function alignedReturn(bars: readonly OhlcBar[], from: string, to: string): number | null {
  const a = bars.find((b) => b.date === from);
  const z = bars.find((b) => b.date === to);
  if (!a || !z || !(a.close > 0)) return null;
  return (z.close - a.close) / a.close;
}

/**
 * Forward outcome over `horizonSessions` trading sessions after the event.
 *
 * Returns null rather than a partial number when the window is not fully
 * covered. A horizon that has not elapsed is NOT a zero return, and a short
 * window silently reported as a full one is the count-not-span bug this repo
 * already shipped once in sector returns.
 *
 * The benchmark leg is aligned by DATE, never by index: the two series can have
 * different holidays, and joining on position would compare different days.
 */
export function computeEventOutcome(
  subject: readonly OhlcBar[],
  benchmark: readonly OhlcBar[],
  occurredAt: string,
  market: string,
  horizonSessions: number,
): EventOutcome | null {
  if (horizonSessions <= 0) return null;
  const start = entryIndex(subject, occurredAt, market);
  if (start < 0) return null;
  const end = start + horizonSessions;
  // Strictly less than length: the exit bar must EXIST, not be extrapolated.
  if (end >= subject.length) return null;

  const entry = subject[start];
  const exit = subject[end];
  if (!(entry.close > 0)) return null;

  // Excursions start at start+1, NOT at the entry bar. We enter at the entry
  // bar's CLOSE, so that bar's intraday high and low are already in the past —
  // and for an intraday-cited event, part of that range happened BEFORE the
  // announcement. Including it books a drawdown the position could never have
  // suffered and makes the event look more dangerous (or more favourable) than
  // it was.
  const window = subject.slice(start + 1, end + 1);
  let lo = entry.close;
  let hi = entry.close;
  for (const b of window) {
    if (Number.isFinite(b.low) && b.low > 0 && b.low < lo) lo = b.low;
    if (Number.isFinite(b.high) && b.high > hi) hi = b.high;
  }

  const fwdReturn = (exit.close - entry.close) / entry.close;
  const benchmarkReturn = alignedReturn(benchmark, entry.date, exit.date);

  return {
    entryDate: entry.date,
    exitDate: exit.date,
    sessionsUsed: horizonSessions,
    fwdReturn,
    benchmarkReturn,
    benchmarkNeutralReturn: benchmarkReturn == null ? null : fwdReturn - benchmarkReturn,
    maxAdverseExcursion: (lo - entry.close) / entry.close,
    maxFavorableExcursion: (hi - entry.close) / entry.close,
  };
}

/**
 * The value a cohort is summarised over.
 *
 * Benchmark-neutral is the honest series for an IDIOSYNCRATIC event: it strips
 * the market move the event did not cause. But for a MARKET-WIDE event the
 * subject IS the benchmark, so the neutral return is identically 0 by
 * construction. Summarising that would report every tariff cohort as exactly
 * zero — which reads like a finding and is an artefact. Those cohorts use the
 * raw forward return, the only series that means anything for them.
 */
export function cohortValue(row: {
  subject_symbol: string | null;
  benchmark_symbol: string;
  fwd_return: number | null;
  benchmark_neutral_return: number | null;
}): number | null {
  const marketWide = row.subject_symbol === row.benchmark_symbol;
  // An idiosyncratic raw return includes market beta. Mixing it with aligned
  // benchmark-neutral rows makes one cohort internally incomparable.
  const value = marketWide ? row.fwd_return : row.benchmark_neutral_return;
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

/** Horizons measured for every event. Fixed BEFORE any estimate is read, per §5. */
export const EVENT_HORIZONS: readonly number[] = [1, 5, 21];

export interface BaseRateSummary {
  eventType: string;
  market: string;
  horizonDays: number;
  n: number;
  /** Null whenever n is below the floor — never a number the sample can't carry. */
  meanReturn: number | null;
  medianReturn: number | null;
  hitRate: number | null;
  stdDev: number | null;
  sufficient: boolean;
}

/**
 * Minimum matured instances before a rate is reported as a number.
 *
 * 20 per §4.4. The failure this exists to prevent is acting at n=8 because the
 * story is good — so the floor is applied by REFUSING to compute, not by
 * printing a number next to a warning that a reader can skip.
 */
export const MIN_INSTANCES = 20;

export function summarizeBaseRate(
  eventType: string,
  market: string,
  horizonDays: number,
  returns: readonly number[],
): BaseRateSummary {
  const xs = returns.filter((r) => Number.isFinite(r));
  const n = xs.length;
  const base: BaseRateSummary = {
    eventType, market, horizonDays, n,
    meanReturn: null, medianReturn: null, hitRate: null, stdDev: null,
    sufficient: n >= MIN_INSTANCES,
  };
  if (!base.sufficient) return base;

  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return {
    ...base,
    meanReturn: mean,
    medianReturn: median,
    hitRate: xs.filter((x) => x > 0).length / n,
    stdDev: Math.sqrt(variance),
  };
}
