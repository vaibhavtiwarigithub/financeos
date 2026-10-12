import { isNearThresholdEntryLong, thresholdDistance } from "./cohort";

type Observation = {
  id: number | string;
  ts: string;
  symbol: string;
  analyst_score: unknown;
  score_threshold: unknown;
  direction: unknown;
  decision_context?: unknown;
  discovery_source?: unknown;
};
type PriorRun = { observation_id: number | string | null; symbol: string; decision_ts: string };

/**
 * Council candidates for one market: every research symbol, once per market session.
 * - Newest observation per symbol (callers pass rows in any order).
 * - A symbol is skipped when it already has a council run for the same session, whichever observation that run used,
 *   so a later same-day research pass never double-scores it.
 * - Near-threshold entry-long candidates (the original predeclared cohort) are ordered first, then the rest.
 */
export function selectCouncilCandidates<T extends Observation>(args: {
  observations: T[];
  priorRuns: PriorRun[];
  sessionOf: (iso: string) => string | null;
}): T[] {
  const newest = new Map<string, T>();
  for (const row of args.observations) {
    const current = newest.get(row.symbol);
    if (!current || String(row.ts).localeCompare(String(current.ts)) > 0 || (row.ts === current.ts && Number(row.id) > Number(current.id))) newest.set(row.symbol, row);
  }
  const doneObservations = new Set(args.priorRuns.map((run) => Number(run.observation_id)));
  const doneSessions = new Set(args.priorRuns.map((run) => `${run.symbol}|${args.sessionOf(String(run.decision_ts))}`));
  return [...newest.values()]
    .filter((row) => !doneObservations.has(Number(row.id)) && !doneSessions.has(`${row.symbol}|${args.sessionOf(String(row.ts))}`))
    .sort((a, b) => Number(isNearThresholdEntryLong(b)) - Number(isNearThresholdEntryLong(a))
      || thresholdDistance(a) - thresholdDistance(b)
      || String(b.ts).localeCompare(String(a.ts))
      || String(a.symbol).localeCompare(String(b.symbol)));
}
