import { createHash } from "node:crypto";
import { computeSpearmanIC } from "@/lib/validation/feature-check";
import { sessionDistanceT } from "@/lib/score-variants/core";

export const COUNCIL_COMPARISON_VERSION = "matched-council-v2-instrument-stratified-descriptive";
export type CouncilComparisonPoint = {
  method: string; symbol: string; session: string; observationId: string;
  decisionTs: string; score: number; baseline: number; outcome: number;
};
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const varying = (xs: number[]) => xs.length > 0 && xs.some((x) => x !== xs[0]);

/** Bounded calendar span with room for 12*h qualifying sessions, label
 * maturation and some missing dates. A fixed 90 days can never clear h10/h20.
 * This is read capacity, not a promise that the data meet an evidence gate.
 */
export function predictionLookbackDays(horizon: number): number {
  if (![2, 5, 10, 20].includes(horizon)) throw new Error("Unsupported prediction horizon");
  return Math.max(90, horizon * 24);
}

/** Only matched raw points enter a comparison. Never subtract aggregate cells
 * with potentially different populations or infer covariance from their t's.
 * Each method has its OWN common baseline sample, not a cross-model ranking.
 */
export function councilComparisons(points: readonly CouncilComparisonPoint[], market: "us" | "india", horizon: number, minCrossSection = 5) {
  if (!Number.isInteger(minCrossSection) || minCrossSection < 5) throw new Error("Cannot weaken the matched comparison floor");
  const methods = new Map<string, Map<string, CouncilComparisonPoint>>();
  for (const p of points) {
    if (![p.score, p.baseline, p.outcome].every(Number.isFinite) || p.score < 0 || p.score > 100 || p.baseline < 0 || p.baseline > 100) continue;
    const slots = methods.get(p.method) ?? new Map<string, CouncilComparisonPoint>();
    const key = `${p.session}:${p.symbol}`;
    const previous = slots.get(key);
    if (!previous || `${p.decisionTs}:${p.observationId}` > `${previous.decisionTs}:${previous.observationId}`) slots.set(key, p);
    methods.set(p.method, slots);
  }
  return [...methods].sort(([a], [b]) => a.localeCompare(b)).map(([method, slots]) => {
    const dates = new Map<string, CouncilComparisonPoint[]>();
    for (const p of slots.values()) { const day = dates.get(p.session) ?? []; day.push(p); dates.set(p.session, day); }
    const sessions: Array<{ day: string; ic: number; baselineIc: number; scoreCorrelation: number }> = [];
    const included: CouncilComparisonPoint[] = [];
    for (const [day, rows] of [...dates].sort(([a], [b]) => a.localeCompare(b))) {
      if (rows.length < minCrossSection) continue;
      const scores = rows.map((r) => r.score), baseline = rows.map((r) => r.baseline), outcomes = rows.map((r) => r.outcome);
      if (![scores, baseline, outcomes].every(varying)) continue;
      const ic = computeSpearmanIC(scores, outcomes), bi = computeSpearmanIC(baseline, outcomes), corr = computeSpearmanIC(scores, baseline);
      if (!ic || !bi || !corr) continue;
      sessions.push({ day, ic: ic.ic, baselineIc: bi.ic, scoreCorrelation: corr.ic }); included.push(...rows);
    }
    const enough = sessions.length >= 20 && sessions.length / horizon >= 12;
    const pairedT = enough ? sessionDistanceT(sessions.map((s) => ({ day: s.day, value: s.ic - s.baselineIc })), horizon, market) : null;
    const sorted = included.sort((a, b) => `${a.session}:${a.symbol}`.localeCompare(`${b.session}:${b.symbol}`));
    return {
      method, minCrossSection, observations: included.length, returnedPoints: slots.size, sessions: sessions.length,
      roughWindows: sessions.length / horizon,
      ic: mean(sessions.map((s) => s.ic)), baselineIc: mean(sessions.map((s) => s.baselineIc)),
      deltaIc: mean(sessions.map((s) => s.ic - s.baselineIc)),
      scoreRankCorrelation: mean(sessions.map((s) => s.scoreCorrelation)),
      descriptiveHacT: pairedT, state: enough ? "descriptive_only" : "insufficient_evidence",
      commonSampleHash: createHash("sha256").update(JSON.stringify(sorted)).digest("hex"),
      statisticsVersion: COUNCIL_COMPARISON_VERSION,
    };
  });
}
