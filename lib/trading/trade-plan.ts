export type TradePlanCurrency = "USD" | "INR";
export type IndicativeTradePlanStatus = "candidate" | "no_entry" | "holding_context" | "unavailable";

export interface IndicativeTradePlan {
  version: "v1";
  kind: "indicative_research_plan";
  status: IndicativeTradePlanStatus;
  currency: TradePlanCurrency;
  reference_price: number | null;
  reference_as_of: string | null;
  reference_age_days: number | null;
  reference_fresh: boolean;
  reference_source: string;
  initial_risk_floor: number | null;
  profit_objective: number | null;
  stop_loss_pct: number;
  target_pct: number;
  horizon_sessions: number;
  mandate_version: number;
  executable: false;
}

export interface ExecutionRiskReward {
  stopLossPct: number;
  targetPct: number;
  source: "ledger_percentile" | "mandate";
  sampleSize: number | null;
}

/**
 * Immutable evidence recorded alongside an entry/proposal. This is deliberately
 * separate from the executable percentages: the same percentages are not enough
 * to reproduce whether a mandate or a particular ledger cohort selected them.
 */
export interface ExecutionRiskPlanProvenance {
  version: "v1";
  observed_at: string;
  market: "us" | "india";
  resolved_horizon_days: number;
  mandate: { version: number; stop_loss_pct: number; target_pct: number };
  resolved: { source: ExecutionRiskReward["source"]; stop_loss_pct: number; target_pct: number; sample_size: number | null };
  ledger_percentile: {
    stop_mae_pctile: number;
    target_mfe_pctile: number;
    stop_percentile: number;
    target_percentile: number;
  } | null;
}

function finitePositive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function boundedPct(value: unknown, fallback: number, max: number): number {
  const n = finitePositive(value);
  return n == null ? fallback : Math.min(max, n);
}

function roundPrice(value: number): number {
  const decimals = Math.abs(value) < 1 ? 4 : 2;
  return Number(value.toFixed(decimals));
}

export function buildIndicativeTradePlan(args: {
  referencePrice: unknown;
  referenceAsOf?: string | null;
  referenceSource?: string | null;
  decisionAt?: string | null;
  currency: TradePlanCurrency;
  stopLossPct: unknown;
  targetPct: unknown;
  horizonSessions: unknown;
  mandateVersion: unknown;
  entryEligible: boolean;
  direction: string;
  isHeld: boolean;
}): IndicativeTradePlan {
  const referencePrice = finitePositive(args.referencePrice);
  const referenceTs = args.referenceAsOf ? Date.parse(args.referenceAsOf) : Number.NaN;
  const decisionTs = args.decisionAt ? Date.parse(args.decisionAt) : Number.NaN;
  const referenceAgeDays = Number.isFinite(referenceTs) && Number.isFinite(decisionTs)
    ? Math.floor((decisionTs - referenceTs) / 86_400_000)
    : null;
  const referenceFresh = referencePrice != null && referenceAgeDays != null
    && referenceAgeDays >= -1 && referenceAgeDays <= 7;
  const stopLossPct = boundedPct(args.stopLossPct, 7, 30);
  const targetPct = boundedPct(args.targetPct, 20, 100);
  const horizonSessions = Math.max(1, Math.min(252, Math.round(finitePositive(args.horizonSessions) ?? 10)));
  const mandateVersion = Math.max(1, Math.round(finitePositive(args.mandateVersion) ?? 1));
  const status: IndicativeTradePlanStatus = !referenceFresh
    ? "unavailable"
    : args.isHeld
      ? "holding_context"
      : args.entryEligible && args.direction === "long"
        ? "candidate"
        : "no_entry";

  return {
    version: "v1",
    kind: "indicative_research_plan",
    status,
    currency: args.currency,
    reference_price: referencePrice == null ? null : roundPrice(referencePrice),
    reference_as_of: args.referenceAsOf ?? null,
    reference_age_days: referenceAgeDays,
    reference_fresh: referenceFresh,
    reference_source: args.referenceSource?.trim() || "unavailable",
    initial_risk_floor: status === "candidate" ? roundPrice(referencePrice! * (1 - stopLossPct / 100)) : null,
    profit_objective: status === "candidate" ? roundPrice(referencePrice! * (1 + targetPct / 100)) : null,
    stop_loss_pct: stopLossPct,
    target_pct: targetPct,
    horizon_sessions: horizonSessions,
    mandate_version: mandateVersion,
    executable: false,
  };
}

export function resolveExecutionRiskReward(args: {
  mandateStopLossPct: unknown;
  mandateTargetPct: unknown;
  learned?: { stopMaePctile: unknown; targetMfePctile: unknown; n: unknown } | null;
}): ExecutionRiskReward {
  const mandateStop = boundedPct(args.mandateStopLossPct, 7, 30);
  const mandateTarget = boundedPct(args.mandateTargetPct, 8, 100);
  const learnedN = Number(args.learned?.n);
  const mae = Number(args.learned?.stopMaePctile);
  const mfe = Number(args.learned?.targetMfePctile);
  const learnedStopPct = Math.abs(mae) * 100;
  const learnedTargetPct = mfe * 100;

  // Preserve the selected policy's levels. Increasing a target to manufacture
  // a nominal reward:risk ratio does not establish positive expectancy.
  if (Number.isFinite(learnedN) && learnedN >= 60 && Number.isFinite(mae) && mae < 0 && Number.isFinite(mfe) && mfe > 0
      && learnedStopPct >= 1 && learnedTargetPct >= 1) {
    return {
      stopLossPct: roundPrice(Math.min(10, learnedStopPct)),
      targetPct: roundPrice(Math.min(40, learnedTargetPct)),
      source: "ledger_percentile",
      sampleSize: Math.round(learnedN),
    };
  }
  return { stopLossPct: mandateStop, targetPct: mandateTarget, source: "mandate", sampleSize: null };
}

export function buildExecutionRiskPlanProvenance(args: {
  market: "us" | "india";
  observedAt: string;
  resolvedHorizonDays: number;
  mandate: { version: unknown; stopLossPct: unknown; targetPct: unknown };
  riskReward: ExecutionRiskReward;
  learned?: { stopMaePctile: unknown; targetMfePctile: unknown } | null;
  stopPercentile?: number;
  targetPercentile?: number;
}): ExecutionRiskPlanProvenance {
  const mandateStop = boundedPct(args.mandate.stopLossPct, 7, 30);
  const mandateTarget = boundedPct(args.mandate.targetPct, 8, 100);
  const mandateVersion = Math.max(1, Math.round(finitePositive(args.mandate.version) ?? 1));
  const horizon = Math.max(1, Math.min(252, Math.round(finitePositive(args.resolvedHorizonDays) ?? 10)));
  const mae = Number(args.learned?.stopMaePctile);
  const mfe = Number(args.learned?.targetMfePctile);
  const ledger = args.riskReward.source === "ledger_percentile"
    && Number.isFinite(mae) && mae < 0 && Number.isFinite(mfe) && mfe > 0
    ? {
      stop_mae_pctile: mae,
      target_mfe_pctile: mfe,
      stop_percentile: finitePositive(args.stopPercentile) ?? 0.25,
      target_percentile: finitePositive(args.targetPercentile) ?? 0.75,
    }
    : null;
  return {
    version: "v1",
    observed_at: args.observedAt,
    market: args.market,
    resolved_horizon_days: horizon,
    mandate: { version: mandateVersion, stop_loss_pct: mandateStop, target_pct: mandateTarget },
    resolved: {
      source: args.riskReward.source,
      stop_loss_pct: args.riskReward.stopLossPct,
      target_pct: args.riskReward.targetPct,
      sample_size: args.riskReward.sampleSize,
    },
    ledger_percentile: ledger,
  };
}

export function bindTradePrices(fillPriceValue: unknown, riskReward: ExecutionRiskReward): {
  stopLoss: number;
  priceTarget: number;
} | null {
  const fillPrice = finitePositive(fillPriceValue);
  if (fillPrice == null) return null;
  return {
    stopLoss: roundPrice(fillPrice * (1 - riskReward.stopLossPct / 100)),
    priceTarget: roundPrice(fillPrice * (1 + riskReward.targetPct / 100)),
  };
}
