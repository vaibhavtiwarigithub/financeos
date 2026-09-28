import { atrReplayBookFromShadowState, atrReplayBookToShadowState, ATR_STOP_FORWARD_BASELINE_VERSION, ATR_STOP_FORWARD_PROGRAM_VERSION, type AtrStopReplayBook } from "@/lib/shadows/atr-stop-forward-replay";
import { ATR_STOP_REPLAY_COST_MODEL_VERSION } from "@/lib/shadows/atr-stop-paired-replay";
import type { AtrReplaySeedResult } from "@/lib/shadows/atr-replay-seed";
import type { ShadowBookSnapshotInput, ShadowBookSnapshotRow, ShadowBookState } from "@/lib/shadows/shadow-book-ledger";

export const ATR_FORWARD_PROGRAM_ID = "exit-stop-shadow";
// Matches the decision-level collector's h10 horizon: one independent block is
// ten non-overlapping sessions.
export const ATR_FORWARD_BLOCK_SESSIONS = 10;
export const ATR_FORWARD_SELL_COST_BPS = 5;

export interface SessionMark {
  prices: Record<string, number>;
  benchmarkClose: number;
}

export interface ForwardHistory {
  seed: ShadowBookSnapshotRow;
  last: ShadowBookSnapshotRow;
  sessions: string[];
  navHistory: ShadowBookSnapshotInput["navHistory"];
  decisionIds: string[];
  cumulativeTurnoverNotional: number;
}

const common = {
  programId: ATR_FORWARD_PROGRAM_ID,
  programVersion: ATR_STOP_FORWARD_PROGRAM_VERSION,
  baselineVersion: ATR_STOP_FORWARD_BASELINE_VERSION,
  independenceBlockSessions: ATR_FORWARD_BLOCK_SESSIONS,
  costModelVersion: ATR_STOP_REPLAY_COST_MODEL_VERSION,
  costsApplied: true as const,
};

function markOf(row: ShadowBookSnapshotRow): SessionMark {
  const mark = (row.point_in_time_inputs as { sessionMark?: SessionMark }).sessionMark;
  if (!mark || typeof mark.benchmarkClose !== "number" || !mark.prices || typeof mark.prices !== "object") {
    throw new Error(`Snapshot ${row.session_date} lacks its persisted session mark; history cannot be rebuilt.`);
  }
  return mark;
}

/** Identical two-arm starting snapshot. It is seed-only: it can never be measured. */
export function buildSeedSnapshotInput(input: {
  market: "us" | "india";
  session: string;
  seed: AtrReplaySeedResult;
  benchmarkClose: number;
}): ShadowBookSnapshotInput {
  const state = atrReplayBookToShadowState(input.seed.book);
  const decisionIds = input.seed.book.positions.map((position) => `seed-position:${position.symbol}`);
  const sessionMark: SessionMark = { prices: input.seed.prices, benchmarkClose: input.benchmarkClose };
  return {
    ...common,
    market: input.market,
    sessionDate: input.session,
    windowStart: input.session,
    expectedSessions: [input.session],
    seedOnly: true,
    baselineInitialState: state,
    variantInitialState: state,
    baselineState: state,
    variantState: state,
    navHistory: [{ session: input.session, baselineState: state, variantState: state, prices: input.seed.prices, benchmarkClose: input.benchmarkClose }],
    turnoverNotional: 0,
    baselineDecisionIds: decisionIds,
    variantDecisionIds: decisionIds,
    pointInTimeInputs: {
      evidenceType: "forward_paired_book",
      sessionMark,
      decisionIds,
      cumulativeTurnoverNotional: 0,
      seed: { nav: input.seed.nav, positionCount: input.seed.book.positions.length, priceBasis: "raw_ohlc" },
    },
  };
}

/** Rebuild the complete ordered mark history from the append-only snapshot rows. */
export function historyFromRows(rowsInput: ShadowBookSnapshotRow[]): ForwardHistory {
  if (!rowsInput.length) throw new Error("No prior snapshots to rebuild history from.");
  const rows = [...rowsInput].sort((a, b) => a.session_date.localeCompare(b.session_date));
  const seed = rows[0];
  if (seed.session_date !== seed.window_start) throw new Error("First snapshot must be the seed anchor at the window start.");
  const sessions: string[] = [];
  const navHistory: ShadowBookSnapshotInput["navHistory"] = [];
  for (const row of rows) {
    if (row.window_start !== seed.window_start) throw new Error(`Snapshot ${row.session_date} belongs to a different window.`);
    if (sessions.includes(row.session_date)) throw new Error(`Duplicate snapshot for ${row.session_date}.`);
    sessions.push(row.session_date);
    const mark = markOf(row);
    navHistory.push({ session: row.session_date, baselineState: row.baseline_state, variantState: row.variant_state, prices: mark.prices, benchmarkClose: mark.benchmarkClose });
  }
  const last = rows[rows.length - 1];
  const inputs = last.point_in_time_inputs as { decisionIds?: string[]; cumulativeTurnoverNotional?: number };
  if (!Array.isArray(inputs.decisionIds) || typeof inputs.cumulativeTurnoverNotional !== "number") {
    throw new Error(`Snapshot ${last.session_date} lacks its cumulative decision population or turnover.`);
  }
  return { seed, last, sessions, navHistory, decisionIds: inputs.decisionIds, cumulativeTurnoverNotional: inputs.cumulativeTurnoverNotional };
}

export function booksFromLast(history: ForwardHistory): { baseline: AtrStopReplayBook; variant: AtrStopReplayBook } {
  return { baseline: atrReplayBookFromShadowState(history.last.baseline_state), variant: atrReplayBookFromShadowState(history.last.variant_state) };
}

/** Snapshot input for one newly advanced session, extending the persisted history. */
export function buildStepSnapshotInput(input: {
  history: ForwardHistory;
  market: "us" | "india";
  session: string;
  /** Complete ordered regular sessions strictly after the seed through `session`. */
  sessionsAfterSeed: string[];
  baselineState: ShadowBookState;
  variantState: ShadowBookState;
  mark: SessionMark;
  turnoverNotional: number;
  newDecisionIds: string[];
}): ShadowBookSnapshotInput {
  const { history } = input;
  const decisionIds = [...new Set([...history.decisionIds, ...input.newDecisionIds])];
  const cumulative = history.cumulativeTurnoverNotional + input.turnoverNotional;
  const windowStart = history.seed.window_start;
  return {
    ...common,
    market: input.market,
    sessionDate: input.session,
    windowStart,
    expectedSessions: [windowStart, ...input.sessionsAfterSeed],
    baselineInitialState: history.seed.baseline_initial_state,
    variantInitialState: history.seed.variant_initial_state,
    baselineState: input.baselineState,
    variantState: input.variantState,
    navHistory: [
      ...history.navHistory,
      { session: input.session, baselineState: input.baselineState, variantState: input.variantState, prices: input.mark.prices, benchmarkClose: input.mark.benchmarkClose },
    ],
    turnoverNotional: cumulative,
    baselineDecisionIds: decisionIds,
    variantDecisionIds: decisionIds,
    pointInTimeInputs: {
      evidenceType: "forward_paired_book",
      sessionMark: input.mark,
      decisionIds,
      cumulativeTurnoverNotional: cumulative,
      seed: (history.seed.point_in_time_inputs as { seed?: unknown }).seed ?? null,
    },
  };
}
