import { computeSpearmanIC } from "@/lib/validation/feature-check";

/**
 * Sector relative strength as a candidate cross-sectional dimension.
 * features/sector-regime-dimension/FEATURE_ARCHITECTURE.md — Stage 1, MEASURE ONLY.
 *
 * WHY THIS AND NOT "BETTER MACRO". `macro` is one market-wide scalar per day, so
 * its rank IC is exactly 0.0000 BY CONSTRUCTION — a constant cannot order a
 * cross-section. Everything EPB Research, Bravos Research and Smart X Terminal
 * publish is also market-wide, so importing it would produce a better-informed
 * scalar that still ranks nothing. Sector is the first macro-flavoured input
 * that VARIES PER SYMBOL and could therefore earn a place in a ranking score.
 *
 * NOTHING HERE IS ON THE MONEY PATH.
 */

export interface Bar { date: string; close: number }

/**
 * Trailing return of a sector against the market, as of a decision date.
 *
 * POINT-IN-TIME. Only bars STRICTLY ON OR BEFORE `asOf` are used, and the
 * lookback window ends there. Including the decision day's own forward bars
 * would leak the outcome into the feature — the same class of error as the
 * calendar-day purge that leaked labels in walkForwardFolds.
 */
export function sectorRelativeStrength(
  sectorBars: Bar[],
  benchmarkBars: Bar[],
  asOf: string,
  lookbackSessions: number,
): number | null {
  const trailing = (bars: Bar[]): number | null => {
    const usable = bars
      .filter((bar) => bar.date <= asOf && Number.isFinite(bar.close) && bar.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (usable.length < lookbackSessions + 1) return null;
    const end = usable[usable.length - 1].close;
    const start = usable[usable.length - 1 - lookbackSessions].close;
    if (!(start > 0)) return null;
    return end / start - 1;
  };
  const sector = trailing(sectorBars);
  const benchmark = trailing(benchmarkBars);
  if (sector == null || benchmark == null) return null;
  return sector - benchmark;
}

export interface SectorScoredRow {
  symbol: string;
  session: string;
  sector: string;
  /** Sector relative strength assigned to this symbol. */
  value: number;
  outcome: number;
  /** The existing technical score, for the correlation check in §6 of the spec. */
  technical: number | null;
}

export interface BreadthReport {
  sessions: number;
  medianNamesPerSession: number;
  medianSectorsPerSession: number;
  /**
   * Rank IC computed over NAMES — the number a naive implementation reports.
   * Inflated, because a sector signal gives every name in a sector the same
   * value, so N names are really K clusters.
   */
  meanIcOverNames: number | null;
  /**
   * Rank IC computed over SECTORS — one observation per sector per session,
   * which is the honest unit when the signal is constant within a sector.
   */
  meanIcOverSectors: number | null;
  /** Sessions that had at least MIN_SECTORS_PER_SESSION distinct sectors. */
  qualifyingSessions: number;
  /** Correlation between the sector score and the existing technical score. */
  technicalCorrelation: number | null;
}

/**
 * Distinct sectors a session needs before its ordering means anything.
 *
 * MUST match computeSpearmanIC's own n >= 5 floor. Set lower (it was 3), a
 * session "qualifies" but yields no sector-level IC, so `qualifyingSessions`
 * counts sessions that contributed nothing — and nEffective, derived from that
 * count, then overstates the sample sitting behind the reported mean. Two
 * floors that disagree is the same defect shape as a monitor and a refresher
 * disagreeing about scope.
 */
export const MIN_SECTORS_PER_SESSION = 5;

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Measure the signal BOTH ways and report the gap.
 *
 * THE TRAP THIS EXISTS TO EXPOSE. A sector signal assigns the same value to
 * every symbol in a sector. Computing rank IC over 80 names when there are 8
 * distinct values treats 8 clusters as 80 independent observations, and the
 * apparent precision is inflated accordingly. This is the same error shape as
 * the naive t of 3.09 versus the overlap-corrected 1.38 measured on technical's
 * bottom quintile — and it is the single easiest way for this feature to
 * manufacture a false positive.
 *
 * So both numbers are reported. `meanIcOverSectors` is the defensible one.
 */
export function measureSectorSignal(rows: SectorScoredRow[]): BreadthReport {
  const bySession = new Map<string, SectorScoredRow[]>();
  for (const row of rows) {
    if (!Number.isFinite(row.value) || !Number.isFinite(row.outcome)) continue;
    const list = bySession.get(row.session) ?? [];
    list.push(row);
    bySession.set(row.session, list);
  }

  const nameIcs: number[] = [];
  const sectorIcs: number[] = [];
  const namesPerSession: number[] = [];
  const sectorsPerSession: number[] = [];
  let qualifying = 0;

  for (const sessionRows of bySession.values()) {
    const sectors = new Set(sessionRows.map((r) => r.sector));
    namesPerSession.push(sessionRows.length);
    sectorsPerSession.push(sectors.size);
    if (sectors.size < MIN_SECTORS_PER_SESSION) continue;
    qualifying++;

    // (a) over names — what a naive implementation would report.
    const overNames = computeSpearmanIC(
      sessionRows.map((r) => r.value),
      sessionRows.map((r) => r.outcome),
    );
    if (overNames && Number.isFinite(overNames.ic)) nameIcs.push(overNames.ic);

    // (b) over sectors — one observation per sector, the honest unit.
    const bySector = new Map<string, { value: number; outcomes: number[] }>();
    for (const row of sessionRows) {
      const entry = bySector.get(row.sector) ?? { value: row.value, outcomes: [] };
      entry.outcomes.push(row.outcome);
      bySector.set(row.sector, entry);
    }
    const sectorValues = [...bySector.values()].map((e) => e.value);
    const sectorOutcomes = [...bySector.values()].map((e) => mean(e.outcomes)!);
    const overSectors = computeSpearmanIC(sectorValues, sectorOutcomes);
    if (overSectors && Number.isFinite(overSectors.ic)) sectorIcs.push(overSectors.ic);
  }

  // Is this just `technical` in slow motion? Sector relative strength IS a
  // momentum measure, and technical currently ranks BACKWARDS at every horizon.
  // A high correlation is a reason to stop, not a footnote.
  const paired = rows.filter((r) => r.technical != null && Number.isFinite(r.value));
  const technicalCorrelation = paired.length >= 5
    ? computeSpearmanIC(paired.map((r) => r.value), paired.map((r) => r.technical as number))?.ic ?? null
    : null;

  return {
    sessions: bySession.size,
    medianNamesPerSession: median(namesPerSession),
    medianSectorsPerSession: median(sectorsPerSession),
    meanIcOverNames: mean(nameIcs),
    meanIcOverSectors: mean(sectorIcs),
    qualifyingSessions: qualifying,
    technicalCorrelation,
  };
}
