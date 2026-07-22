import { LABEL_COST_HAIRCUT, type LabelCandle } from "@/lib/learning/label-math";

export const ATR_EXIT_POLICY_VERSION = "close_observed_v1";
export const ATR_EXIT_MIN_LABELS = 60;

export interface AtrExitPolicy {
  id: string;
  stopAtr: number;
  partialTargetAtr: number;
  finalTargetAtr: number;
  postPartialTrailAtr: number;
  partialFraction: number;
}

// A deliberately small, predeclared hypothesis family. These policies are
// evidence labels only; no execution code imports or activates them.
export const ATR_EXIT_POLICIES: readonly AtrExitPolicy[] = [
  {
    id: "tight_1_0_1_5_2_5_0_5",
    stopAtr: 1,
    partialTargetAtr: 1.5,
    finalTargetAtr: 2.5,
    postPartialTrailAtr: 0.5,
    partialFraction: 0.5,
  },
  {
    id: "balanced_1_5_2_0_3_0_1_0",
    stopAtr: 1.5,
    partialTargetAtr: 2,
    finalTargetAtr: 3,
    postPartialTrailAtr: 1,
    partialFraction: 0.5,
  },
  {
    id: "wide_2_0_2_5_4_0_1_5",
    stopAtr: 2,
    partialTargetAtr: 2.5,
    finalTargetAtr: 4,
    postPartialTrailAtr: 1.5,
    partialFraction: 0.5,
  },
] as const;

export interface AtrExitOutcome {
  policyId: string;
  policyVersion: string;
  netReturn: number;
  exitDay: number;
  exitReason: "initial_stop" | "trailing_stop" | "final_target" | "horizon";
  partialTriggered: boolean;
}

export function readEntryAtr(features: unknown): number | null {
  if (!features || typeof features !== "object") return null;
  const technical = (features as Record<string, unknown>).technical;
  if (!technical || typeof technical !== "object") return null;
  const value = Number((technical as Record<string, unknown>).atr14);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Simulates the same information cadence as the daily PositionMonitor: only a
// completed session close may trigger an exit. It does not infer intraday touch
// order or pretend a barrier price was executable.
export function simulateAtrExitPolicy(
  entryPrice: number,
  entryAtr: number,
  candlesAfterEntry: LabelCandle[],
  horizonDays: number,
  policy: AtrExitPolicy
): AtrExitOutcome | null {
  if (
    !Number.isFinite(entryPrice) || entryPrice <= 0 ||
    !Number.isFinite(entryAtr) || entryAtr <= 0 ||
    candlesAfterEntry.length < horizonDays || horizonDays <= 0
  ) return null;

  const window = candlesAfterEntry.slice(0, horizonDays);
  const initialStop = entryPrice - policy.stopAtr * entryAtr;
  const partialTarget = entryPrice + policy.partialTargetAtr * entryAtr;
  const finalTarget = entryPrice + policy.finalTargetAtr * entryAtr;
  let remaining = 1;
  let realizedGrossReturn = 0;
  let partialTriggered = false;
  let peakClose = entryPrice;

  for (let index = 0; index < window.length; index++) {
    const close = window[index].close;
    if (!Number.isFinite(close) || close <= 0) return null;
    peakClose = Math.max(peakClose, close);

    const activeStop = partialTriggered
      ? Math.max(entryPrice, peakClose - policy.postPartialTrailAtr * entryAtr)
      : initialStop;
    if (close <= activeStop) {
      realizedGrossReturn += remaining * ((close - entryPrice) / entryPrice);
      return {
        policyId: policy.id,
        policyVersion: ATR_EXIT_POLICY_VERSION,
        netReturn: realizedGrossReturn - LABEL_COST_HAIRCUT,
        exitDay: index + 1,
        exitReason: partialTriggered ? "trailing_stop" : "initial_stop",
        partialTriggered,
      };
    }

    if (close >= finalTarget) {
      realizedGrossReturn += remaining * ((close - entryPrice) / entryPrice);
      return {
        policyId: policy.id,
        policyVersion: ATR_EXIT_POLICY_VERSION,
        netReturn: realizedGrossReturn - LABEL_COST_HAIRCUT,
        exitDay: index + 1,
        exitReason: "final_target",
        partialTriggered,
      };
    }

    if (!partialTriggered && close >= partialTarget) {
      const sold = Math.min(policy.partialFraction, remaining);
      realizedGrossReturn += sold * ((close - entryPrice) / entryPrice);
      remaining -= sold;
      partialTriggered = true;
    }
  }

  const horizonClose = window[window.length - 1].close;
  realizedGrossReturn += remaining * ((horizonClose - entryPrice) / entryPrice);
  return {
    policyId: policy.id,
    policyVersion: ATR_EXIT_POLICY_VERSION,
    netReturn: realizedGrossReturn - LABEL_COST_HAIRCUT,
    exitDay: horizonDays,
    exitReason: "horizon",
    partialTriggered,
  };
}

export function computeAtrExitOutcomes(
  entryPrice: number,
  entryAtr: number | null,
  candlesAfterEntry: LabelCandle[],
  horizonDays: number
): AtrExitOutcome[] | null {
  if (entryAtr == null) return null;
  const outcomes = ATR_EXIT_POLICIES.map(policy =>
    simulateAtrExitPolicy(entryPrice, entryAtr, candlesAfterEntry, horizonDays, policy)
  );
  return outcomes.every((outcome): outcome is AtrExitOutcome => outcome != null) ? outcomes : null;
}

export interface AtrPolicyEvidenceRow {
  policyId: string;
  n: number;
  nEffective: number;
  avgNetReturn: number;
  avgDeltaVsHorizon: number;
  winRate: number;
  worstReturn: number;
  avgExitDay: number;
  partialRate: number;
  status: "insufficient_sample" | "reviewable_evidence";
}

export function aggregateAtrExitEvidence(
  rows: Array<{ horizonReturn: number; outcomes: AtrExitOutcome[] }>,
  horizonDays: number
): AtrPolicyEvidenceRow[] {
  return ATR_EXIT_POLICIES.map(policy => {
    const matched = rows.flatMap(row => {
      const outcome = row.outcomes.find(candidate =>
        candidate.policyId === policy.id && candidate.policyVersion === ATR_EXIT_POLICY_VERSION
      );
      return outcome ? [{ outcome, horizonReturn: row.horizonReturn }] : [];
    });
    const n = matched.length;
    const nEffective = horizonDays > 0 ? n / horizonDays : 0;
    const sum = (pick: (row: (typeof matched)[number]) => number) =>
      matched.reduce((total, row) => total + pick(row), 0);
    return {
      policyId: policy.id,
      n,
      nEffective,
      avgNetReturn: n ? sum(row => row.outcome.netReturn) / n : 0,
      avgDeltaVsHorizon: n ? sum(row => row.outcome.netReturn - row.horizonReturn) / n : 0,
      winRate: n ? matched.filter(row => row.outcome.netReturn > 0).length / n : 0,
      worstReturn: n ? Math.min(...matched.map(row => row.outcome.netReturn)) : 0,
      avgExitDay: n ? sum(row => row.outcome.exitDay) / n : 0,
      partialRate: n ? matched.filter(row => row.outcome.partialTriggered).length / n : 0,
      status: n >= ATR_EXIT_MIN_LABELS && nEffective >= 12
        ? "reviewable_evidence"
        : "insufficient_sample",
    };
  });
}
