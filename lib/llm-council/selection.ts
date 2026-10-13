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
 * Council candidates for one market: the newest observation of every research symbol that has not been scored yet.
 * Research runs several times a day and the paper trader acts after each run, so the council scores EVERY new
 * observation (one per research slot), never a day-end sample. An observation that already has a council run is skipped.
 * Near-threshold entry-long candidates (the original predeclared cohort) are ordered first, then the rest.
 */
export function selectCouncilCandidates<T extends Observation>(args: {
  observations: T[];
  priorRuns: PriorRun[];
}): T[] {
  const newest = new Map<string, T>();
  for (const row of args.observations) {
    const current = newest.get(row.symbol);
    if (!current || String(row.ts).localeCompare(String(current.ts)) > 0 || (row.ts === current.ts && Number(row.id) > Number(current.id))) newest.set(row.symbol, row);
  }
  const doneObservations = new Set(args.priorRuns.map((run) => Number(run.observation_id)));
  return [...newest.values()]
    .filter((row) => !doneObservations.has(Number(row.id)))
    .sort((a, b) => Number(isNearThresholdEntryLong(b)) - Number(isNearThresholdEntryLong(a))
      || thresholdDistance(a) - thresholdDistance(b)
      || String(b.ts).localeCompare(String(a.ts))
      || String(a.symbol).localeCompare(String(b.symbol)));
}
