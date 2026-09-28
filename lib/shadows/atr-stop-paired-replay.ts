import { canonicalize } from "@/lib/analytics/alpha-diagnostic-contract";
import type { SimulationPolicy } from "@/lib/simulation/portfolio-simulator";
import type { DailyMark } from "@/lib/strategy-replay/nav-marker";
import { ATR_STOP_FORWARD_BASELINE_VERSION, ATR_STOP_FORWARD_PROGRAM_VERSION, advanceAtrStopReplaySession, type AtrStopReplayBook, type AtrStopReplayStepInput } from "@/lib/shadows/atr-stop-forward-replay";
import { runPairedPortfolioReplay, type PairedPortfolioReplayResult, type ReplayEntryEvent } from "@/lib/shadows/paired-portfolio-replay";
import { atrStopStepToPortfolioEvents } from "@/lib/shadows/atr-stop-paired-events";

export const ATR_STOP_REPLAY_COST_MODEL_VERSION = "paper-recorded-fills-plus-5bps-replay-sells-v1";

export interface AtrStopPairedReplayInput {
  market: "us" | "india";
  windowStart: string;
  windowEnd: string;
  expectedSessions: string[];
  initialBook: AtrStopReplayBook;
  policy: SimulationPolicy;
  /** One baseline and one challenger step for each session strictly after the shared anchor. */
  steps: Array<{ baseline: AtrStopReplayStepInput; variant: AtrStopReplayStepInput }>;
  marks: DailyMark[];
  pointInTimeInputs: unknown;
  independenceBlockSessions: number;
}

export interface AtrStopPairedReplayOutput {
  replay: PairedPortfolioReplayResult;
  diagnostics: {
    replayedSessions: number;
    entryDecisionCount: number;
    baselineExitCount: number;
    variantExitCount: number;
    corporateActionSessionsRefused: number;
  };
}

function commonStep(input: AtrStopReplayStepInput): unknown {
  return {
    market: input.market, priceBasis: input.priceBasis, session: input.session,
    bars: input.bars, corporateActions: input.corporateActions, entries: input.entries,
    confirmedScoreExitSymbols: input.confirmedScoreExitSymbols ?? [],
    externalExits: input.externalExits ?? [], costs: input.costs,
  };
}

function sameInitialBooks(left: AtrStopReplayBook, right: AtrStopReplayBook): boolean {
  return canonicalize(left) === canonicalize(right);
}

function policyMatchesSeed(policy: SimulationPolicy, seed: AtrStopReplayBook): boolean {
  if (policy.market !== seed.market || Math.abs(policy.initialCash - seed.cash) > 1e-8) return false;
  const expected = seed.positions.map((position) => ({ symbol: position.symbol, quantity: position.quantity, costBasis: position.costBasis }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const actual = [...(policy.initialPositions ?? [])].sort((a, b) => a.symbol.localeCompare(b.symbol));
  return canonicalize(expected) === canonicalize(actual);
}

/**
 * Run the path-specific ATR stop stepper in both arms, then feed its actual
 * fills into the strict shared portfolio attribution contract. This composes
 * accounting; it does not fetch data, invent candidate decisions, or persist.
 */
export function runAtrStopPairedPortfolioReplay(input: AtrStopPairedReplayInput): AtrStopPairedReplayOutput {
  if (input.initialBook.market !== input.market || input.initialBook.session !== input.windowStart) {
    throw new Error("ATR replay seed market/session must equal the declared market/window start.");
  }
  if (!policyMatchesSeed(input.policy, input.initialBook)) {
    throw new Error("Shared simulation policy must reconcile exactly to the frozen ATR replay seed cash and positions.");
  }
  if (input.steps.length !== input.expectedSessions.length - 1 || input.steps.length < 2) {
    throw new Error("ATR paired replay requires one baseline/challenger step for every post-anchor market session and at least two return intervals.");
  }
  if (input.expectedSessions[0] !== input.windowStart || input.expectedSessions.at(-1) !== input.windowEnd) {
    throw new Error("ATR paired replay sessions must include the declared anchor and end session.");
  }

  let baselineBook: AtrStopReplayBook = structuredClone(input.initialBook);
  let variantBook: AtrStopReplayBook = structuredClone(input.initialBook);
  const baselineEvents: ReplayEntryEvent[] = [];
  const variantEvents: ReplayEntryEvent[] = [];
  const candidateIds: string[] = [];
  let baselineExitCount = 0;
  let variantExitCount = 0;
  const costsVersions = new Set<string>();

  for (let index = 0; index < input.steps.length; index++) {
    const { baseline, variant } = input.steps[index];
    const expectedSession = input.expectedSessions[index + 1];
    if (baseline.market !== input.market || variant.market !== input.market
      || baseline.session !== expectedSession || variant.session !== expectedSession
      || baseline.arm !== "baseline" || variant.arm !== "atr_2_8") {
      throw new Error(`ATR replay step ${index + 1} is not the matched market/session/baseline/challenger contract.`);
    }
    if (canonicalize(baseline.book) !== canonicalize(baselineBook) || canonicalize(variant.book) !== canonicalize(variantBook)) {
      throw new Error(`ATR replay step ${expectedSession} does not continue exactly from the preceding persisted book state.`);
    }
    if (canonicalize(commonStep(baseline)) !== canonicalize(commonStep(variant))) {
      throw new Error(`Baseline and ATR challenger do not share identical point-in-time inputs on ${expectedSession}.`);
    }
    costsVersions.add(baseline.costs.version);
    for (const entry of baseline.entries) candidateIds.push(entry.decisionId);

    const baselineResult = advanceAtrStopReplaySession(baseline);
    const variantResult = advanceAtrStopReplaySession(variant);
    baselineEvents.push(...atrStopStepToPortfolioEvents({ step: baseline, result: baselineResult }).events);
    variantEvents.push(...atrStopStepToPortfolioEvents({ step: variant, result: variantResult }).events);
    baselineExitCount += baselineResult.exits.length;
    variantExitCount += variantResult.exits.length;
    baselineBook = baselineResult.book;
    variantBook = variantResult.book;
  }
  if (costsVersions.size !== 1) throw new Error("ATR paired replay requires one unchanged versioned execution-cost contract for the full window.");
  if (!candidateIds.length || new Set(candidateIds).size !== candidateIds.length) {
    throw new Error("ATR paired replay requires a non-empty unique, point-in-time entry decision population.");
  }

  const replay = runPairedPortfolioReplay({
    programId: "exit-stop-shadow",
    market: input.market,
    comparisonType: "matched_replay",
    programVersion: ATR_STOP_FORWARD_PROGRAM_VERSION,
    baselineVersion: ATR_STOP_FORWARD_BASELINE_VERSION,
    asOfSession: input.windowEnd,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    expectedSessions: input.expectedSessions,
    policy: input.policy,
    baselineEvents,
    variantEvents,
    marks: input.marks,
    baselineDecisionIds: candidateIds,
    variantDecisionIds: candidateIds,
    pointInTimeInputs: input.pointInTimeInputs,
    costModelVersion: ATR_STOP_REPLAY_COST_MODEL_VERSION,
    independenceBlockSessions: input.independenceBlockSessions,
  });

  return {
    replay,
    diagnostics: {
      replayedSessions: input.steps.length,
      entryDecisionCount: candidateIds.length,
      baselineExitCount,
      variantExitCount,
      corporateActionSessionsRefused: 0,
    },
  };
}
