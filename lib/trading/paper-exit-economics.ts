import { paperPartialTargetQuantity, type PaperQuantityMarket } from "@/lib/trading/paper-quantity";

export interface PaperExitEconomics {
  targetReturnPct: number | null;
  stopReturnPct: number | null;
  rewardRiskRatio: number | null;
  targetExitQty: number | null;
  runnerQty: number | null;
  targetExitWeight: number | null;
  minimumGrossGainIfTargetHitsPct: number | null;
}

function positive(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function rounded(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

/**
 * Describes the currently executable one-target paper plan. "Minimum gross"
 * assumes the target slice fills at the target and a remaining runner later
 * exits at entry; it is deliberately not labelled expected return because no
 * target-hit probability is estimated here.
 */
export function paperExitEconomics(input: {
  market: PaperQuantityMarket;
  heldQty: unknown;
  entryPrice: unknown;
  stopPrice: unknown;
  targetPrice: unknown;
}): PaperExitEconomics {
  const qty = positive(input.heldQty);
  const entry = positive(input.entryPrice);
  const stop = positive(input.stopPrice);
  const target = positive(input.targetPrice);

  const targetReturnPct = entry != null && target != null
    ? rounded(((target / entry) - 1) * 100)
    : null;
  const stopReturnPct = entry != null && stop != null
    ? rounded(((stop / entry) - 1) * 100)
    : null;
  const rewardRiskRatio = targetReturnPct != null && targetReturnPct > 0
    && stopReturnPct != null && stopReturnPct < 0
      ? rounded(targetReturnPct / Math.abs(stopReturnPct), 2)
      : null;

  if (qty == null || targetReturnPct == null || targetReturnPct <= 0) {
    return {
      targetReturnPct, stopReturnPct, rewardRiskRatio,
      targetExitQty: null, runnerQty: null, targetExitWeight: null,
      minimumGrossGainIfTargetHitsPct: null,
    };
  }

  const partialQty = paperPartialTargetQuantity(input.market, qty);
  const targetExitQty = partialQty ?? qty;
  const runnerQty = rounded(qty - targetExitQty, 6);
  const targetExitWeight = targetExitQty / qty;
  return {
    targetReturnPct,
    stopReturnPct,
    rewardRiskRatio,
    targetExitQty,
    runnerQty,
    targetExitWeight: rounded(targetExitWeight, 6),
    minimumGrossGainIfTargetHitsPct: rounded(targetReturnPct * targetExitWeight),
  };
}
