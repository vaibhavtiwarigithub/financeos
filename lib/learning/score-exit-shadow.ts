import { effectiveObservations, MIN_EFFECTIVE_OBSERVATIONS } from "./dimension-diagnostics";

export const SCORE_EXIT_POLICY_VERSION = "score-exit-shadow-v1";
export const SCORE_EXIT_OFFSETS = [0, -10, -20] as const;

export type ScoreExitShadowPoint = {
  date: string;
  symbol: string;
  score: number;
  entryThreshold: number;
  forwardReturn: number;
  benchmarkNeutralReturn: number | null;
  mae: number | null;
  mfe: number | null;
};

export type ScoreExitArm = {
  id: string;
  thresholdOffset: number | null;
  triggered: number;
  cleanTriggered: number;
  unresolvedMechanical: number;
  meanIncrementalVsHold: number | null;
  medianIncrementalVsHold: number | null;
  avoidedLossShare: number | null;
  foregoneGainShare: number | null;
  worstIncrementalVsHold: number | null;
};

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function arm(points: ScoreExitShadowPoint[], offset: number, stopPct: number, targetPct: number): ScoreExitArm {
  const triggered = points.filter((point) => point.score < point.entryThreshold + offset);
  // MFE/MAE do not reveal which barrier happened first. A row touching either
  // mechanical exit is therefore unresolved, not silently attributed to score.
  const clean = triggered.filter((point) => {
    const stopTouched = point.mae != null && point.mae <= -stopPct;
    const targetTouched = point.mfe != null && point.mfe >= targetPct;
    return !stopTouched && !targetTouched;
  });
  // Exit-to-cash at the observation price versus continuing to hold. The
  // benchmark leg cancels in the paired comparison, so the increment is -R.
  const increments = clean.map((point) => -point.forwardReturn);
  return {
    id: `entry_threshold${offset >= 0 ? "+" : ""}${offset}`,
    thresholdOffset: offset,
    triggered: triggered.length,
    cleanTriggered: clean.length,
    unresolvedMechanical: triggered.length - clean.length,
    meanIncrementalVsHold: mean(increments),
    medianIncrementalVsHold: median(increments),
    avoidedLossShare: clean.length ? clean.filter((point) => point.forwardReturn < 0).length / clean.length : null,
    foregoneGainShare: clean.length ? clean.filter((point) => point.forwardReturn > 0).length / clean.length : null,
    worstIncrementalVsHold: increments.length ? Math.min(...increments) : null,
  };
}

export function evaluateScoreExitShadow(input: {
  market: "us" | "india";
  horizonDays: number;
  points: ScoreExitShadowPoint[];
  stopPct: number;
  targetPct: number;
}) {
  const byKey = new Map<string, ScoreExitShadowPoint>();
  for (const point of input.points) byKey.set(`${point.date}:${point.symbol}`, point);
  const points = [...byKey.values()];
  const sessions = new Set(points.map((point) => point.date)).size;
  const nEffective = effectiveObservations(sessions, input.horizonDays);
  const status = nEffective >= MIN_EFFECTIVE_OBSERVATIONS ? "measured_descriptive" : "insufficient_evidence";
  return {
    policyVersion: SCORE_EXIT_POLICY_VERSION,
    market: input.market,
    horizonDays: input.horizonDays,
    observationCount: points.length,
    distinctSessions: sessions,
    effectiveObservations: nEffective,
    status,
    baseline: { id: "no_score_exit", observations: points.length },
    arms: SCORE_EXIT_OFFSETS.map((offset) => arm(points, offset, input.stopPct, input.targetPct)),
    reason: status === "insufficient_evidence"
      ? `${nEffective.toFixed(2)}/${MIN_EFFECTIVE_OBSERVATIONS} effective non-overlapping observations; descriptive only.`
      : "Evidence floor met; still measure-only and requires owner review before any policy proposal.",
  };
}
