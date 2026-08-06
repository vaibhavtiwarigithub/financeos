// Decision-label coverage — pure.
//
// WHY THIS EXISTS
// On 2026-08-06 a diagnosis of portfolio underperformance produced a confident
// causal story (`features/portfolio-underperformance/DIAGNOSIS.md`) and was
// refuted by the next query. Two mistakes, both invisible in the summary
// statistics that motivated it:
//
//   1. `n` was read as the sample size. A cohort of "n=536" spanned 14 dates;
//      one of "n=74" spanned 7 dates and 18 symbols. Observations repeat across
//      correlated symbols and overlapping forward windows, so the EFFECTIVE
//      independent sample is closer to the count of distinct decision DATES.
//   2. The cohort blamed for the largest loss had `entry_eligible = false` on
//      every row — it had never bought anything and could not have cost
//      anything.
//
// So this module reports distinct dates and distinct symbols BESIDE n, and
// refuses a verdict when the date count is short. It measures whether other
// programs' evidence is yet capable of supporting a conclusion.
//
// MEASUREMENT ONLY. No score, eligibility, sizing, entry, exit, promotion or
// broker path reads any of this.

export interface LabelRow {
  /** Decision date, YYYY-MM-DD. */
  date: string;
  symbol: string;
  horizonDays: number;
  /** Whether the decision was actually eligible to become a position. */
  entryEligible: boolean;
}

export interface HorizonCoverage {
  horizonDays: number;
  observations: number;
  distinctDates: number;
  distinctSymbols: number;
  eligibleObservations: number;
  /** Mean observations per date — how much of `n` is repetition. */
  observationsPerDate: number;
  sufficient: boolean;
}

/**
 * Distinct decision dates required before a horizon's cohort may be read as
 * evidence rather than as an anecdote.
 *
 * 20 is one trading month. It is not a claim that 20 is statistically
 * sufficient — overlapping forward windows mean even 20 dates carry far less
 * information than 20 independent draws. It is the floor below which a result
 * is definitely one regime, which is the failure that actually occurred.
 */
export const MIN_DISTINCT_DATES = 20;

/** The horizon the books actually trade — exits fire on an 11-market-day clock. */
export const PRIMARY_HORIZON_DAYS = 10;

export function coverageByHorizon(rows: readonly LabelRow[]): HorizonCoverage[] {
  const byHorizon = new Map<number, LabelRow[]>();
  for (const row of rows) {
    const bucket = byHorizon.get(row.horizonDays);
    if (bucket) bucket.push(row);
    else byHorizon.set(row.horizonDays, [row]);
  }

  const out: HorizonCoverage[] = [];
  for (const [horizonDays, group] of byHorizon) {
    const dates = new Set(group.map((r) => r.date));
    const symbols = new Set(group.map((r) => r.symbol));
    out.push({
      horizonDays,
      observations: group.length,
      distinctDates: dates.size,
      distinctSymbols: symbols.size,
      eligibleObservations: group.filter((r) => r.entryEligible).length,
      observationsPerDate: dates.size === 0 ? 0 : group.length / dates.size,
      sufficient: dates.size >= MIN_DISTINCT_DATES,
    });
  }
  return out.sort((a, b) => a.horizonDays - b.horizonDays);
}

/**
 * The primary horizon's coverage, or the longest available below it.
 *
 * Coverage always shrinks as the horizon lengthens (a 20-day label needs 20 more
 * days to exist), so the traded horizon is the binding one — a healthy 2-day
 * cohort says nothing about whether a 10-day claim is supportable.
 */
export function bindingCoverage(coverage: readonly HorizonCoverage[]): HorizonCoverage | null {
  if (coverage.length === 0) return null;
  const exact = coverage.find((c) => c.horizonDays === PRIMARY_HORIZON_DAYS);
  if (exact) return exact;
  const below = coverage.filter((c) => c.horizonDays <= PRIMARY_HORIZON_DAYS);
  return below.length ? below[below.length - 1] : coverage[0];
}

/**
 * Human-readable blockers. Empty only when the binding horizon clears the floor.
 * Each string names the number that fails, so the reason survives being pasted
 * out of context.
 */
export function coverageBlockers(coverage: readonly HorizonCoverage[]): string[] {
  const binding = bindingCoverage(coverage);
  if (!binding) return ["No matured decision labels exist for this market."];

  const blockers: string[] = [];
  if (!binding.sufficient) {
    blockers.push(
      `The ${binding.horizonDays}-day horizon spans ${binding.distinctDates} distinct decision date(s), below the floor of ${MIN_DISTINCT_DATES}. Any result from it describes one regime.`,
    );
  }
  if (binding.observationsPerDate >= 5) {
    blockers.push(
      `${binding.observations} observations come from ${binding.distinctDates} date(s) (${binding.observationsPerDate.toFixed(1)} per date), so n overstates the independent sample.`,
    );
  }
  if (binding.eligibleObservations === 0 && binding.observations > 0) {
    blockers.push(
      `None of the ${binding.observations} observations at this horizon were entry-eligible, so this cohort cannot explain realised P&L.`,
    );
  }
  return blockers;
}
