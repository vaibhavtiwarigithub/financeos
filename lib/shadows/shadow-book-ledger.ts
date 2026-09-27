import { createHash } from "node:crypto";
import { canonicalize } from "@/lib/analytics/alpha-diagnostic-contract";

export interface ShadowBookPosition {
  symbol: string;
  quantity: number;
  costBasis: number;
}

export interface ShadowBookState {
  market: "us" | "india";
  session: string;
  cash: number;
  positions: ShadowBookPosition[];
}

export interface ShadowBookSnapshotInput {
  programId: string;
  market: "us" | "india";
  programVersion: string;
  baselineVersion: string;
  sessionDate: string;
  windowStart: string;
  /** Complete, ordered market sessions from windowStart through sessionDate. */
  expectedSessions: string[];
  independenceBlockSessions: number;
  baselineInitialState: ShadowBookState;
  variantInitialState: ShadowBookState;
  baselineState: ShadowBookState;
  variantState: ShadowBookState;
  /** Complete portfolio and benchmark marks for every session, including both endpoints. */
  navHistory: Array<{
    session: string;
    baselineState: ShadowBookState;
    variantState: ShadowBookState;
    prices: Record<string, number>;
    benchmarkClose: number;
  }>;
  turnoverNotional: number;
  costModelVersion: string;
  costsApplied: true;
  baselineDecisionIds: string[];
  variantDecisionIds: string[];
  pointInTimeInputs: unknown;
}

export interface ShadowBookSnapshotRow {
  program_id: string;
  market: "us" | "india";
  program_version: string;
  baseline_version: string;
  session_date: string;
  window_start: string;
  status: "captured";
  baseline_initial_state: ShadowBookState;
  variant_initial_state: ShadowBookState;
  baseline_state: ShadowBookState;
  variant_state: ShadowBookState;
  initial_nav: number;
  benchmark_initial_close: number;
  baseline_nav: number;
  variant_nav: number;
  benchmark_nav: number;
  baseline_cumulative_return_pct: number;
  variant_cumulative_return_pct: number;
  benchmark_cumulative_return_pct: number;
  net_incremental_return_pct: number;
  benchmark_relative_incremental_return_pct: number;
  baseline_drawdown_pct: number;
  variant_drawdown_pct: number;
  turnover_pct: number;
  independent_blocks: number;
  matched_population_hash: string;
  input_snapshot_hash: string;
  cost_model_version: string;
  point_in_time_inputs: Record<string, unknown>;
  blockers: string[];
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function nav(state: ShadowBookState, prices: Record<string, number>): number {
  if (!Number.isFinite(state.cash) || state.cash < 0) throw new Error("Shadow book cash must be finite and non-negative.");
  const seen = new Set<string>();
  let total = state.cash;
  for (const position of state.positions) {
    const symbol = position.symbol.trim().toUpperCase();
    if (!symbol || seen.has(symbol) || !positive(position.quantity) || !positive(position.costBasis)) {
      throw new Error("Shadow book positions must have unique symbols and positive quantity/cost basis.");
    }
    seen.add(symbol);
    const mark = prices[symbol];
    if (!positive(mark)) throw new Error(`Missing same-session close for held symbol ${symbol}; snapshot refused.`);
    total += mark * position.quantity;
  }
  if (!positive(total)) throw new Error("Shadow book NAV must be positive.");
  return total;
}

function samePopulation(a: string[], b: string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, i) => value === right[i])
    && new Set(left).size === left.length;
}

function maxDrawdown(values: number[]): number {
  let peak = 0;
  let max = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) max = Math.max(max, (peak - value) / peak * 100);
  }
  return max;
}

/**
 * Create a single complete daily snapshot. This is descriptive P&L only;
 * attribution readiness remains governed by independent, non-overlapping blocks
 * and the strict paired replay contract. Even after two blocks this remains a
 * descriptive snapshot; confidence bounds are produced by the matched replayer.
 */
export function buildShadowBookSnapshot(input: ShadowBookSnapshotInput): ShadowBookSnapshotRow {
  if (!input.programId.trim() || !input.programVersion.trim() || !input.baselineVersion.trim() || !input.costModelVersion.trim()) {
    throw new Error("Program and policy versions plus cost model are required.");
  }
  if (input.baselineInitialState.market !== input.market || input.variantInitialState.market !== input.market
    || input.baselineState.market !== input.market || input.variantState.market !== input.market) {
    throw new Error("Shadow-book states must stay within one market.");
  }
  if (input.baselineInitialState.session !== input.windowStart || input.variantInitialState.session !== input.windowStart
    || input.baselineState.session !== input.sessionDate || input.variantState.session !== input.sessionDate) {
    throw new Error("Initial/current state sessions must match the replay window endpoints.");
  }
  if (input.sessionDate < input.windowStart || !Number.isInteger(input.independenceBlockSessions) || input.independenceBlockSessions < 1) {
    throw new Error("Shadow-book window or independent-block length is invalid.");
  }
  const sessions = input.expectedSessions;
  if (sessions.length < 2 || sessions[0] !== input.windowStart || sessions[sessions.length - 1] !== input.sessionDate
    || sessions.some((session, i) => !/^\d{4}-\d{2}-\d{2}$/.test(session) || (i > 0 && session <= sessions[i - 1]))) {
    throw new Error("Snapshot requires the complete ordered market-session window including both endpoints.");
  }
  if (!samePopulation(input.baselineDecisionIds, input.variantDecisionIds) || !input.baselineDecisionIds.length) {
    throw new Error("Baseline and variant must share the exact same non-empty point-in-time decision population.");
  }
  if (input.costsApplied !== true) throw new Error("Gross-only shadow snapshots cannot be reported as P&L evidence.");
  if (!Number.isFinite(input.turnoverNotional) || input.turnoverNotional < 0) {
    throw new Error("Turnover must be finite and non-negative.");
  }

  if (input.navHistory.length !== sessions.length || input.navHistory.some((point, i) => point.session !== sessions[i])) {
    throw new Error("Every expected market session needs exactly one baseline, variant and benchmark mark.");
  }
  const history = input.navHistory.map((point) => {
    if (!positive(point.benchmarkClose) || point.baselineState.session !== point.session || point.variantState.session !== point.session
      || point.baselineState.market !== input.market || point.variantState.market !== input.market) {
      throw new Error("NAV history has a missing benchmark mark or mismatched session/market state.");
    }
    return {
      session: point.session,
      baselineNav: nav(point.baselineState, point.prices),
      variantNav: nav(point.variantState, point.prices),
      benchmarkClose: point.benchmarkClose,
    };
  });
  if (canonicalize(input.navHistory[0].baselineState) !== canonicalize(input.baselineInitialState)
    || canonicalize(input.navHistory[0].variantState) !== canonicalize(input.variantInitialState)
    || canonicalize(input.navHistory[history.length - 1].baselineState) !== canonicalize(input.baselineState)
    || canonicalize(input.navHistory[history.length - 1].variantState) !== canonicalize(input.variantState)) {
    throw new Error("Initial and final book states must exactly match the persisted replay endpoints.");
  }
  const initialNav = history[0].baselineNav;
  if (Math.abs(history[0].variantNav - initialNav) > 0.000001) throw new Error("Both replay arms must start at identical initial portfolio value.");
  const baselineNav = history[history.length - 1].baselineNav;
  const variantNav = history[history.length - 1].variantNav;
  const benchmarkInitialClose = history[0].benchmarkClose;
  const benchmarkClose = history[history.length - 1].benchmarkClose;
  const baselinePath = history.map((row) => row.baselineNav);
  const variantPath = history.map((row) => row.variantNav);
  const baselineReturn = (baselineNav / initialNav - 1) * 100;
  const variantReturn = (variantNav / initialNav - 1) * 100;
  const benchmarkReturn = (benchmarkClose / benchmarkInitialClose - 1) * 100;
  const incremental = variantReturn - baselineReturn;
  const independentBlocks = Math.floor((sessions.length - 1) / input.independenceBlockSessions);
  const positions = input.baselineInitialState.positions.length + input.variantInitialState.positions.length
    + input.baselineState.positions.length + input.variantState.positions.length;

  const pointInTimeInputs = {
    ...(input.pointInTimeInputs && typeof input.pointInTimeInputs === "object" && !Array.isArray(input.pointInTimeInputs)
      ? input.pointInTimeInputs as Record<string, unknown>
      : { source: input.pointInTimeInputs }),
    completeMarketSessions: sessions,
    sessionMarkCount: input.navHistory.length,
    observedPositionCount: positions,
    costsApplied: input.costsApplied,
  };
  const row: ShadowBookSnapshotRow = {
    program_id: input.programId,
    market: input.market,
    program_version: input.programVersion,
    baseline_version: input.baselineVersion,
    session_date: input.sessionDate,
    window_start: input.windowStart,
    status: "captured",
    baseline_initial_state: input.baselineInitialState,
    variant_initial_state: input.variantInitialState,
    baseline_state: input.baselineState,
    variant_state: input.variantState,
    initial_nav: initialNav,
    benchmark_initial_close: benchmarkInitialClose,
    baseline_nav: baselineNav,
    variant_nav: variantNav,
    benchmark_nav: benchmarkClose,
    baseline_cumulative_return_pct: baselineReturn,
    variant_cumulative_return_pct: variantReturn,
    benchmark_cumulative_return_pct: benchmarkReturn,
    net_incremental_return_pct: incremental,
    benchmark_relative_incremental_return_pct: incremental,
    baseline_drawdown_pct: maxDrawdown(baselinePath),
    variant_drawdown_pct: maxDrawdown(variantPath),
    turnover_pct: input.turnoverNotional / initialNav * 100,
    independent_blocks: independentBlocks,
    matched_population_hash: sha256([...input.baselineDecisionIds].sort()),
    input_snapshot_hash: sha256({ input, initialNav, baselineNav, variantNav, benchmarkReturn }),
    cost_model_version: input.costModelVersion,
    point_in_time_inputs: pointInTimeInputs,
    blockers: [
      ...(independentBlocks < 2 ? ["Fewer than two complete non-overlapping return blocks; the period is still accumulating."] : []),
      "Daily P&L is descriptive only; program-specific paired replay and its confidence gates are not represented by this snapshot.",
    ],
  };
  return row;
}

const IDENTITY_COLUMNS = [
  "program_id", "market", "program_version", "baseline_version", "session_date",
] as const;

/** Append-only idempotent writer. Conflicting retries fail visibly. */
export async function writeShadowBookSnapshot(client: any, row: ShadowBookSnapshotRow): Promise<"inserted" | "already_present"> {
  const find = () => {
    let query = client.from("upgrade_path_shadow_book_runs").select("*");
    for (const key of IDENTITY_COLUMNS) query = query.eq(key, row[key]);
    return query.maybeSingle();
  };
  const projection = (value: Record<string, unknown>) => {
    const { id: _id, created_at: _created, ...stable } = value;
    return stable;
  };
  const { data: existing, error: readError } = await find();
  if (readError) throw new Error(`Shadow-book idempotency lookup failed: ${readError.message}`);
  if (existing) {
    if (canonicalize(projection(existing)) === canonicalize(projection(row as unknown as Record<string, unknown>))) return "already_present";
    throw new Error("Conflicting immutable shadow-book snapshot exists for this session.");
  }
  const { error } = await client.from("upgrade_path_shadow_book_runs").insert(row);
  if (!error) return "inserted";
  const { data: concurrent, error: retryReadError } = await find();
  if (!retryReadError && concurrent && canonicalize(projection(concurrent)) === canonicalize(projection(row as unknown as Record<string, unknown>))) return "already_present";
  throw new Error(`Shadow-book snapshot append failed: ${error.message}`);
}
