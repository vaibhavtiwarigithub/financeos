import type { ReplayEntryEvent } from "@/lib/shadows/paired-portfolio-replay";
import type { AtrStopReplayStepInput, AtrStopReplayStepResult } from "@/lib/shadows/atr-stop-forward-replay";

export interface AtrStopPairedEvents {
  events: ReplayEntryEvent[];
  decisionIds: string[];
  diagnostics: { entries: number; exits: number; recordedExitFillCount: number; modeledExitCostBps: number };
}

/**
 * Adapt one deterministic ATR-book step to the shared portfolio accounting
 * simulator. This intentionally refuses data the simulator cannot represent
 * (corporate actions, ambiguous event phases, and unreconciled paper sells).
 */
export function atrStopStepToPortfolioEvents(input: {
  step: AtrStopReplayStepInput;
  result: AtrStopReplayStepResult;
  /**
   * The events omit split/dividend cashflows. That is only acceptable when the
   * caller takes NAV from the stepper's own books (which credit them) and uses
   * these events for turnover alone, as the forward shadow book does.
   */
  allowCorporateActions?: boolean;
}): AtrStopPairedEvents {
  const { step, result } = input;
  if (step.corporateActions.length && !input.allowCorporateActions) {
    throw new Error("Paired portfolio adapter does not yet model split/dividend event cashflows; this window is not attributable.");
  }
  if (result.unmatchedExternalExits.length) {
    throw new Error("A recorded paper sale does not reconcile to the replay-arm position quantity.");
  }
  const unsupportedEntryExclusions = result.excludedEntries.filter((entry) => entry.reason !== "insufficient_arm_cash");
  if (unsupportedEntryExclusions.length) {
    throw new Error(`Replay entry is not comparable across arms: ${unsupportedEntryExclusions.map((entry) => `${entry.decisionId}:${entry.reason}`).join(", ")}`);
  }

  const decisionIds = step.entries.map((entry) => entry.decisionId);
  if (decisionIds.some((id) => !id.trim()) || new Set(decisionIds).size !== decisionIds.length) {
    throw new Error("ATR portfolio replay requires unique point-in-time decision IDs for every entry event.");
  }
  const entries = step.entries.map<ReplayEntryEvent>((entry) => ({
    id: entry.decisionId,
    decisionId: entry.decisionId,
    session: entry.session,
    symbol: entry.symbol,
    kind: "entry",
    price: entry.fillPrice,
    quantity: entry.quantity,
    // Entry ledger fill prices already contain the paper execution slip.
    costPct: 0,
  }));

  const recordedExitTimes = result.exits
    .filter((exit) => exit.executionSource === "recorded_fill")
    .map((exit) => exit.filledAt!);
  const entryTimes = step.entries.map((entry) => entry.filledAt);
  let recordedExitsAfterEntries = false;
  if (recordedExitTimes.length && entryTimes.length) {
    const earliestExit = Math.min(...recordedExitTimes.map(Date.parse));
    const latestExit = Math.max(...recordedExitTimes.map(Date.parse));
    const earliestEntry = Math.min(...entryTimes.map(Date.parse));
    const latestEntry = Math.max(...entryTimes.map(Date.parse));
    const allBefore = latestExit < earliestEntry;
    const allAfter = earliestExit > latestEntry;
    if (!allBefore && !allAfter) {
      throw new Error("Recorded sales interleave same-session entries; the portfolio simulator cannot preserve that cash-ordering contract.");
    }
    recordedExitsAfterEntries = allAfter;
  }

  const exitSequence = new Map<string, number>();
  const exits = result.exits.map<ReplayEntryEvent>((exit) => {
    const key = `${exit.symbol.toUpperCase()}:${exit.reason}:${exit.executionSource}`;
    const sequence = (exitSequence.get(key) ?? 0) + 1;
    exitSequence.set(key, sequence);
    const recorded = exit.executionSource === "recorded_fill";
    return {
      id: `${step.market}:${step.session}:${key}:${sequence}`,
      session: step.session,
      symbol: exit.symbol,
      kind: "exit",
      price: exit.fillPrice,
      quantity: exit.quantity,
      // Real paper fills are all-in prices; replay-generated exits need the
      // declared sell cost. Preserve the simulator's coarse same-session phase.
      costPct: recorded ? 0 : step.costs.sellCostBps / 10_000,
      afterEntry: recorded ? recordedExitsAfterEntries : false,
    };
  });

  return {
    events: [...entries, ...exits],
    decisionIds,
    diagnostics: {
      entries: entries.length,
      exits: exits.length,
      recordedExitFillCount: recordedExitTimes.length,
      modeledExitCostBps: step.costs.sellCostBps,
    },
  };
}
