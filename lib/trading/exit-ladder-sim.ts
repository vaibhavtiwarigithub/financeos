// Daily-bar replay of the shared paper/live exit ladder — MEASUREMENT ONLY.
//
// Unlike exit-path-sim.ts, this models the actual partial-target contract:
// half is banked at the observed close, the runner stop moves to breakeven or
// better, and the remainder continues behind the ratcheting trail.
import { decideExitLadder } from "@/lib/trading/exit-ladder";
import type { PaperQuantityMarket } from "@/lib/trading/paper-quantity";
import type { SimBar } from "@/lib/trading/exit-path-sim";

export interface LadderSimPolicy {
  market: PaperQuantityMarket;
  qty: number;
  stopPct: number;
  targetPct?: number;
  maxSessions: number;
  /** Paper US observes a session low; India/live-close-only paths do not. */
  useSessionLow: boolean;
}

export interface LadderSimResult {
  ret: number | null;
  finalReason: "stop" | "target_full" | "mark" | "unresolved";
  partialTaken: boolean;
  sessions: number;
}

/**
 * bars[0] is a synthetic entry observation at the actual fill price. It is
 * never evaluated. Subsequent bars are evaluated exactly through the shared
 * ladder core; any surviving quantity is marked at the horizon rather than
 * pretending that the measurement cap is a real time exit.
 */
export function simulateExitLadderPath(
  bars: readonly SimBar[],
  policy: LadderSimPolicy,
): LadderSimResult {
  const entry = bars[0]?.close;
  if (!(entry > 0) || !(policy.qty > 0) || !(policy.stopPct > 0)
      || policy.maxSessions < 1 || bars.length < 2) {
    return { ret: null, finalReason: "unresolved", partialTaken: false, sessions: 0 };
  }

  const initialQty = policy.qty;
  let qty = initialQty;
  let highestPrice = entry;
  let currentStop = entry * (1 - policy.stopPct);
  let partialTaken = false;
  let realizedReturn = 0;
  const target = policy.targetPct == null ? null : entry * (1 + policy.targetPct);
  const last = Math.min(policy.maxSessions, bars.length - 1);

  for (let i = 1; i <= last; i++) {
    const bar = bars[i];
    if (!(bar?.close > 0)) continue;
    const decision = decideExitLadder({
      market: policy.market,
      qty,
      avgEntry: entry,
      price: bar.close,
      stopCheckPrice: policy.useSessionLow ? Math.min(bar.close, bar.low) : bar.close,
      priceTarget: target,
      initialStopLoss: entry * (1 - policy.stopPct),
      currentStop,
      highestPrice,
      partialTaken,
    });

    if (decision.action === "partial_target") {
      const exitQty = decision.exitQty ?? 0;
      realizedReturn += (exitQty / initialQty) * ((bar.close - entry) / entry);
      qty -= exitQty;
      partialTaken = true;
      currentStop = decision.runnerStop ?? decision.trailingStop;
      highestPrice = decision.highestPrice;
      continue;
    }
    if (decision.action === "stop_full") {
      realizedReturn += (qty / initialQty) * ((decision.trailingStop - entry) / entry);
      return { ret: realizedReturn, finalReason: "stop", partialTaken, sessions: i };
    }
    if (decision.action === "target_full") {
      realizedReturn += (qty / initialQty) * ((bar.close - entry) / entry);
      return { ret: realizedReturn, finalReason: "target_full", partialTaken, sessions: i };
    }

    currentStop = decision.trailingStop;
    highestPrice = decision.highestPrice;
  }

  const mark = bars[last]?.close;
  if (!(mark > 0)) return { ret: null, finalReason: "unresolved", partialTaken, sessions: last };
  realizedReturn += (qty / initialQty) * ((mark - entry) / entry);
  return { ret: realizedReturn, finalReason: "mark", partialTaken, sessions: last };
}
