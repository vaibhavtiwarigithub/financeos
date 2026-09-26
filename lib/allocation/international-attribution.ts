import { createHash } from "node:crypto";
import { canonicalize } from "@/lib/analytics/alpha-diagnostic-contract";
import type { UpgradePathAttributionRow } from "@/lib/shadows/attribution";
import { MIN_MATCHED_SESSIONS, runInternationalAllocationReplay, type AllocationReplayBar } from "@/lib/allocation/international-replay";

export const INTERNATIONAL_ALLOCATION_PROGRAM_VERSION = "us-voo-vxus-monthly-80-20-v1";
export const INTERNATIONAL_ALLOCATION_BASELINE_VERSION = "us-voo-buy-hold-v1";
export const INTERNATIONAL_ALLOCATION_COST_MODEL = "monthly-rebalance-one-way-5bps-initial-entry-excluded-v1";

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

/**
 * Produces only the already-predeclared 100% VOO vs 80% VOO/20% VXUS
 * historical diagnostic. This is a synthetic fixed-allocation portfolio,
 * never a reconstruction or forecast of Kairos paper/live holdings.
 */
export function buildInternationalAllocationAttribution(
  voo: AllocationReplayBar[],
  vxus: AllocationReplayBar[],
): { row: Omit<UpgradePathAttributionRow, "created_at"> | null; reason: string; replay: ReturnType<typeof runInternationalAllocationReplay> } {
  const replay = runInternationalAllocationReplay(voo, vxus, { testWeightPct: 20, oneWayCostBps: 5 });
  if (replay.status !== "completed") return { row: null, reason: replay.reason ?? "Matched history is insufficient.", replay };
  if (replay.independentBlocks < 2 || replay.blockCiLowerPct == null || replay.blockCiUpperPct == null) {
    return { row: null, reason: `Need at least two complete non-overlapping ${63}-session blocks for uncertainty; have ${replay.independentBlocks}.`, replay };
  }
  if (!replay.startDate || !replay.endDate || !replay.baseline || !replay.testSleeve || !replay.baselineGross || !replay.testSleeveGross) {
    return { row: null, reason: "Replay lacks complete endpoint metrics.", replay };
  }

  const config = {
    market: "us", currency: "USD", baseline: "VOO 100% buy-and-hold",
    variant: "VOO 80% / VXUS 20%, monthly rebalance at matched close",
    oneWayCostBps: 5, initialEntryCostIncluded: false,
    minimumMatchedSessions: MIN_MATCHED_SESSIONS, independenceBlockSessions: 63,
    priceConvention: "adjusted close: Yahoo replay backfill stores adjclose; Massive history uses adjusted=true",
  };
  // Hash only the bars that actually contributed to this frozen window. VOO
  // continues advancing after VXUS's latest matched session; hashing those
  // unused tail bars would turn an idempotent daily retry into a false conflict.
  const usedVoo = voo.filter((bar) => bar.date >= replay.startDate! && bar.date <= replay.endDate!);
  const usedVxus = vxus.filter((bar) => bar.date >= replay.startDate! && bar.date <= replay.endDate!);
  const matchedSessions = usedVoo.map((bar) => bar.date);
  const inputs = { voo: usedVoo, vxus: usedVxus, config, replay };
  const row: Omit<UpgradePathAttributionRow, "created_at"> = {
    program_id: "international-allocation",
    market: "us",
    program_version: INTERNATIONAL_ALLOCATION_PROGRAM_VERSION,
    baseline_version: INTERNATIONAL_ALLOCATION_BASELINE_VERSION,
    comparison_type: "matched_replay",
    state: "measured",
    as_of_session: replay.endDate,
    window_start: replay.startDate,
    window_end: replay.endDate,
    baseline_portfolio_return_pct: replay.baselineGross.totalReturnPct,
    variant_portfolio_return_pct: replay.testSleeveGross.totalReturnPct,
    baseline_net_portfolio_return_pct: replay.baseline.totalReturnPct,
    variant_net_portfolio_return_pct: replay.testSleeve.totalReturnPct,
    benchmark_return_pct: replay.baseline.totalReturnPct,
    incremental_return_pct: replay.testSleeveGross.totalReturnPct - replay.baselineGross.totalReturnPct,
    net_incremental_return_pct: replay.testSleeve.totalReturnPct - replay.baseline.totalReturnPct,
    benchmark_relative_incremental_return_pct: replay.testSleeve.totalReturnPct - replay.baseline.totalReturnPct,
    drawdown_delta_pct: replay.testSleeve.maxDrawdownPct - replay.baseline.maxDrawdownPct,
    turnover_pct: replay.turnoverPct,
    independent_sessions: replay.independentBlocks,
    ci_lower_pct: replay.blockCiLowerPct,
    ci_upper_pct: replay.blockCiUpperPct,
    t_statistic: replay.blockTStatistic,
    matched_population_hash: sha256({ market: "us", matchedSessions }),
    input_snapshot_hash: sha256(inputs),
    cost_model_version: INTERNATIONAL_ALLOCATION_COST_MODEL,
    validity_reason: `Synthetic fixed-allocation diagnostic only; not Kairos paper/live holdings. 95% Student-t interval and t-stat use ${replay.independentBlocks} non-overlapping 63-session active-return blocks.`,
    constraints: {
      same_market: true, same_window: true, same_population: true, non_overlapping_sessions: true,
      cost_basis: "net", benchmark_market: "us", benchmark_symbol: "VOO",
      baseline_arm: "100% VOO buy-and-hold", variant_arm: "80% VOO / 20% VXUS monthly rebalance",
      independence_unit: "non-overlapping 63-session compounded net active-return blocks",
      ci_method: "two-sided 95% Student-t interval across independent block differences",
      ci_target_label: "Mean compounded net active-return difference per 63-session block",
      independence_block_sessions: 63,
      initial_entry_cost_excluded_equally: true,
      synthetic_portfolio_not_kairos_book: true,
      minimum_matched_sessions: MIN_MATCHED_SESSIONS,
      matched_sessions: matchedSessions.length,
      price_convention: config.priceConvention,
    },
  };
  return { row, reason: "Complete matched replay with independent-block uncertainty.", replay };
}
