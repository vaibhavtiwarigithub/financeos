import { createHash } from "node:crypto";
import { canonicalize } from "@/lib/analytics/alpha-diagnostic-contract";
import { expectedMarketSessionsBetween } from "@/lib/trading/market-calendar";
import type { UpgradePathAttributionRow } from "@/lib/shadows/attribution";
import { pairedBlockStats } from "@/lib/shadows/paired-portfolio-replay";
import type { ShadowBookSnapshotRow, ShadowBookState } from "@/lib/shadows/shadow-book-ledger";

export const MIN_ATTRIBUTION_BLOCKS = 2;

export type ShadowBookAttributionResult =
  | { state: "collecting"; reason: string; asOfSession: string | null; independentBlocks: number }
  | { state: "measured"; row: Omit<UpgradePathAttributionRow, "created_at">; independentBlocks: number; discardedTrailingSessions: number };

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function same(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nav(state: ShadowBookState, prices: Record<string, number>): number {
  if (!Number.isFinite(state.cash) || state.cash < 0) throw new Error("Snapshot cash is missing or invalid.");
  let value = state.cash;
  const seen = new Set<string>();
  for (const position of state.positions) {
    const symbol = position.symbol.toUpperCase();
    const mark = prices[symbol];
    if (seen.has(symbol) || !positive(position.quantity) || !positive(mark)) {
      throw new Error(`Snapshot has duplicate/unmarked holding ${symbol}.`);
    }
    seen.add(symbol);
    value += position.quantity * mark;
  }
  if (!positive(value)) throw new Error("Snapshot NAV is non-positive.");
  return value;
}

function peakDrawdown(values: number[]): number {
  let peak = 0;
  let worst = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) worst = Math.max(worst, (peak - value) / peak * 100);
  }
  return worst;
}

/**
 * Converts only a complete, append-only paired book history into net portfolio
 * attribution. It never infers gross P&L from recorded fills that already
 * contain slippage, and it will not fill missing sessions or marks.
 */
export function buildShadowBookAttribution(rowsInput: ShadowBookSnapshotRow[], blockLength: number): ShadowBookAttributionResult {
  if (!rowsInput.length) return { state: "collecting", reason: "No persisted paired shadow-book snapshots exist yet.", asOfSession: null, independentBlocks: 0 };
  const rows = [...rowsInput].sort((a, b) => a.session_date.localeCompare(b.session_date));
  const first = rows[0];
  const last = rows.at(-1)!;
  if (!Number.isInteger(blockLength) || blockLength < 1) throw new Error("Snapshot history lacks a valid independent-block length.");
  if (first.session_date !== first.window_start) throw new Error("The first paired snapshot must be the seed anchor.");

  const baselineInitial = first.baseline_initial_state;
  const variantInitial = first.variant_initial_state;
  const initialNav = Number(first.initial_nav);
  const initialBenchmark = Number(first.benchmark_initial_close);
  if (!positive(initialNav) || !positive(initialBenchmark) || Math.abs(nav(baselineInitial, markOf(first).prices) - initialNav) > 1e-6
    || Math.abs(nav(variantInitial, markOf(first).prices) - initialNav) > 1e-6) {
    throw new Error("Paired shadow books do not reconcile to the same positive seed NAV.");
  }

  const sessions: string[] = [];
  const baselineNavs: number[] = [];
  const variantNavs: number[] = [];
  const benchmarkCloses: number[] = [];
  let previousPopulation: string[] | null = null;
  let commonMetadata: { market: string; program_id: string; program_version: string; baseline_version: string; cost_model_version: string } | null = null;

  for (const row of rows) {
    const metadata = {
      market: row.market, program_id: row.program_id, program_version: row.program_version,
      baseline_version: row.baseline_version, cost_model_version: row.cost_model_version,
    };
    if (!commonMetadata) commonMetadata = metadata;
    if (!same(metadata, commonMetadata) || row.status !== "captured" || row.window_start !== first.window_start) {
      throw new Error(`Snapshot ${row.session_date} changed market, program/policy version, cost model, or replay window.`);
    }
    if (row.market !== "us" && row.market !== "india") throw new Error(`Snapshot ${row.session_date} has an unsupported market.`);
    if (sessions.includes(row.session_date) || (sessions.length && row.session_date <= sessions.at(-1)!)) {
      throw new Error("Snapshot sessions must be unique and strictly ordered.");
    }
    if (!same(row.baseline_initial_state, baselineInitial) || !same(row.variant_initial_state, variantInitial)
      || Math.abs(Number(row.initial_nav) - initialNav) > 1e-6 || Math.abs(Number(row.benchmark_initial_close) - initialBenchmark) > 1e-9) {
      throw new Error(`Snapshot ${row.session_date} does not share the immutable starting book and benchmark anchor.`);
    }
    if (row.baseline_state.session !== row.session_date || row.variant_state.session !== row.session_date
      || row.baseline_state.market !== row.market || row.variant_state.market !== row.market) {
      throw new Error(`Snapshot ${row.session_date} has a mismatched book session or market.`);
    }

    const input = row.point_in_time_inputs as Record<string, unknown>;
    const mark = input?.sessionMark as { prices?: Record<string, number>; benchmarkClose?: number } | undefined;
    if (!mark?.prices || !positive(mark.benchmarkClose)) throw new Error(`Snapshot ${row.session_date} lacks persisted same-session portfolio/benchmark marks.`);
    const expectedThroughDate = row.session_date === first.window_start
      ? []
      : expectedMarketSessionsBetween(row.market, first.window_start, row.session_date);
    const expected = [first.window_start, ...expectedThroughDate];
    const declared = input.completeMarketSessions;
    if (!Array.isArray(declared) || !same(declared, expected)) throw new Error(`Snapshot ${row.session_date} does not declare the complete market-local calendar window.`);
    if (row.session_date !== first.window_start && expected.at(-1) !== row.session_date) throw new Error(`Snapshot ${row.session_date} is not a completed market session.`);

    const decisions = input.decisionIds;
    if (!Array.isArray(decisions) || decisions.some((id) => typeof id !== "string") || new Set(decisions).size !== decisions.length) {
      throw new Error(`Snapshot ${row.session_date} lacks a unique matched decision population.`);
    }
    const sortedIds = [...decisions].sort();
    if (row.matched_population_hash !== digest(sortedIds)) throw new Error(`Snapshot ${row.session_date} decision-population hash does not verify.`);
    // The matched population is cumulative: new entries are ADDED each session. The earlier check had this
    // inverted (it threw when the current snapshot contained an id the previous one lacked), so the first new
    // entry after the seed (MU, 2026-09-28) failed every later ATR collector run. Only a REMOVED id is an error.
    if (previousPopulation) {
      const current = new Set(sortedIds);
      if (previousPopulation.some((id) => !current.has(id))) {
        throw new Error(`Snapshot ${row.session_date} removed decisions from the cumulative matched population.`);
      }
    }
    previousPopulation = sortedIds;

    const baselineValue = nav(row.baseline_state, mark.prices);
    const variantValue = nav(row.variant_state, mark.prices);
    if (Math.abs(baselineValue - Number(row.baseline_nav)) > 1e-5 || Math.abs(variantValue - Number(row.variant_nav)) > 1e-5
      || Math.abs(mark.benchmarkClose - Number(row.benchmark_nav)) > 1e-7) {
      throw new Error(`Snapshot ${row.session_date} NAV fields do not reconcile to persisted state and marks.`);
    }
    sessions.push(row.session_date);
    baselineNavs.push(baselineValue);
    variantNavs.push(variantValue);
    benchmarkCloses.push(mark.benchmarkClose);
  }

  if (sessions[0] !== first.window_start || sessions.at(-1) !== last.session_date) throw new Error("Snapshot series does not cover its declared endpoints.");
  const fullExpected = last.session_date === first.window_start
    ? [first.window_start]
    : [first.window_start, ...expectedMarketSessionsBetween(first.market, first.window_start, last.session_date)];
  if (!same(sessions, fullExpected)) throw new Error("Paired shadow-book rows have a missing or extra market session; attribution is refused.");
  const intervalCount = sessions.length - 1;
  const independentBlocks = Math.floor(intervalCount / blockLength);
  if (independentBlocks < MIN_ATTRIBUTION_BLOCKS) {
    return {
      state: "collecting",
      asOfSession: last.session_date,
      independentBlocks,
      reason: `Paired book is complete through ${last.session_date}, with ${independentBlocks}/${MIN_ATTRIBUTION_BLOCKS} complete non-overlapping ${blockLength}-session return blocks; no attribution row is written yet.`,
    };
  }

  const blockDeltas: number[] = [];
  for (let block = 0; block < independentBlocks; block++) {
    const start = block * blockLength;
    const end = start + blockLength;
    const baselineReturn = baselineNavs[end] / baselineNavs[start] - 1;
    const variantReturn = variantNavs[end] / variantNavs[start] - 1;
    blockDeltas.push((variantReturn - baselineReturn) * 100);
  }
  const stats = pairedBlockStats(blockDeltas);
  const baselineNet = (baselineNavs.at(-1)! / initialNav - 1) * 100;
  const variantNet = (variantNavs.at(-1)! / initialNav - 1) * 100;
  const benchmarkReturn = (benchmarkCloses.at(-1)! / initialBenchmark - 1) * 100;
  const turnover = Number(last.turnover_pct);
  if (![baselineNet, variantNet, benchmarkReturn, turnover, stats.lower, stats.upper].every(Number.isFinite)) {
    throw new Error("Paired net attribution contains a non-finite return, turnover, or confidence bound.");
  }
  const snapshotHashes = rows.map((row) => ({ session: row.session_date, hash: row.input_snapshot_hash }));
  const row: Omit<UpgradePathAttributionRow, "created_at"> = {
    program_id: first.program_id,
    market: first.market,
    program_version: first.program_version,
    baseline_version: first.baseline_version,
    comparison_type: "matched_replay",
    state: "measured",
    return_basis: "net_only",
    as_of_session: last.session_date,
    window_start: first.window_start,
    window_end: last.session_date,
    baseline_portfolio_return_pct: null,
    variant_portfolio_return_pct: null,
    baseline_net_portfolio_return_pct: baselineNet,
    variant_net_portfolio_return_pct: variantNet,
    benchmark_return_pct: benchmarkReturn,
    incremental_return_pct: null,
    net_incremental_return_pct: variantNet - baselineNet,
    benchmark_relative_incremental_return_pct: (variantNet - benchmarkReturn) - (baselineNet - benchmarkReturn),
    drawdown_delta_pct: peakDrawdown(variantNavs) - peakDrawdown(baselineNavs),
    turnover_pct: turnover,
    independent_sessions: independentBlocks,
    ci_lower_pct: stats.lower,
    ci_upper_pct: stats.upper,
    t_statistic: stats.t,
    matched_population_hash: last.matched_population_hash,
    input_snapshot_hash: digest(snapshotHashes),
    cost_model_version: first.cost_model_version,
    validity_reason: "Net-only paired portfolio attribution from the immutable forward shadow-book series. Recorded source fills already include execution slippage; gross returns are unavailable and intentionally NULL.",
    constraints: {
      same_market: true,
      same_window: true,
      same_population: true,
      non_overlapping_sessions: true,
      cost_basis: "net",
      return_basis: "net_only",
      benchmark_market: first.market,
      independence_block_sessions: blockLength,
      confidence_interval: "95% two-sided Student-t on non-overlapping compounded net active-return differences",
      turnover_formula: "variant filled notional / initial NAV * 100 from the paired shadow-book ledger",
      source_ledger: "upgrade_path_shadow_book_runs",
      source_snapshot_count: rows.length,
      gross_return_unavailable_reason: "recorded paper fill prices include execution costs and cannot be de-slipped from this ledger",
    },
  };
  return { state: "measured", row, independentBlocks, discardedTrailingSessions: intervalCount - independentBlocks * blockLength };
}

function markOf(row: ShadowBookSnapshotRow): { prices: Record<string, number> } {
  const mark = (row.point_in_time_inputs as any)?.sessionMark;
  if (!mark?.prices || typeof mark.prices !== "object") throw new Error(`Snapshot ${row.session_date} lacks its price mark.`);
  return mark;
}
