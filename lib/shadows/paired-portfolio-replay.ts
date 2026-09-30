import { createHash } from "node:crypto";
import { canonicalize } from "@/lib/analytics/alpha-diagnostic-contract";
import { simulatePortfolio, type SimulationEvent, type SimulationPolicy, type SimulatedFill, type SimulationRejection } from "@/lib/simulation/portfolio-simulator";
import { markNavSeries, type DailyMark, type HoldingsAt, type NavSeries } from "@/lib/strategy-replay/nav-marker";
import { expectedMarketSessionsBetween } from "@/lib/trading/market-calendar";
import type { UpgradePathAttributionRow } from "./attribution";

export type ReplayEntryEvent = SimulationEvent & { decisionId?: string };

export interface PairedPortfolioReplayInput {
  programId: string;
  market: "us" | "india";
  comparisonType: "matched_replay" | "paper_cohort";
  programVersion: string;
  baselineVersion: string;
  asOfSession: string;
  windowStart: string;
  windowEnd: string;
  expectedSessions: string[];
  policy: SimulationPolicy;
  baselineEvents: ReplayEntryEvent[];
  variantEvents: ReplayEntryEvent[];
  marks: DailyMark[];
  /** Full point-in-time candidate universe presented to BOTH arms. */
  baselineDecisionIds: string[];
  variantDecisionIds: string[];
  pointInTimeInputs: unknown;
  costModelVersion: string;
  independenceBlockSessions: number;
}

export interface PairedPortfolioReplayResult {
  row: Omit<UpgradePathAttributionRow, "created_at">;
  diagnostics: {
    baselineFills: number;
    variantFills: number;
    baselineRejections: SimulationRejection[];
    variantRejections: SimulationRejection[];
    unpricedSessions: { baseline: number; variant: number };
    completeIndependentBlocks: number;
    discardedTrailingSessions: number;
  };
}

type Arm = { grossNav: NavSeries; netNav: NavSeries; grossFills: SimulatedFill[]; netFills: SimulatedFill[]; rejections: SimulationRejection[] };

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function navFor(policy: SimulationPolicy, fills: SimulatedFill[], marks: DailyMark[]): NavSeries {
  const holdingsBySymbol = new Map((policy.initialPositions ?? []).map((position) => [position.symbol, { ...position }]));
  const eventsBySession = new Map<string, SimulatedFill[]>();
  for (const fill of fills) {
    const onDay = eventsBySession.get(fill.session) ?? [];
    onDay.push(fill);
    eventsBySession.set(fill.session, onDay);
  }
  let cash = policy.initialCash;
  const daily: HoldingsAt[] = [];
  for (const mark of marks) {
    for (const fill of eventsBySession.get(mark.session) ?? []) {
      const current = holdingsBySymbol.get(fill.symbol);
      if (fill.kind === "entry") {
        cash -= fill.gross + fill.cost;
        const quantity = (current?.quantity ?? 0) + fill.quantity;
        const basis = (current?.costBasis ?? 0) * (current?.quantity ?? 0) + fill.gross + fill.cost;
        holdingsBySymbol.set(fill.symbol, { symbol: fill.symbol, quantity, costBasis: basis / quantity });
      } else {
        if (!current || fill.quantity > current.quantity + 1e-9) throw new Error("Replay fill ledger cannot be reconciled to NAV holdings.");
        cash += fill.gross - fill.cost;
        const remaining = current.quantity - fill.quantity;
        if (remaining <= 1e-9) holdingsBySymbol.delete(fill.symbol);
        else holdingsBySymbol.set(fill.symbol, { ...current, quantity: remaining });
      }
    }
    daily.push({ session: mark.session, cash, positions: [...holdingsBySymbol.values()].map((p) => ({ ...p })) });
  }
  return markNavSeries(daily, marks);
}

function runArm(policy: SimulationPolicy, events: ReplayEntryEvent[], marks: DailyMark[]): Arm {
  const ids = events.map((event) => event.id);
  if (new Set(ids).size !== ids.length) throw new Error("Replay arm contains duplicate event IDs.");
  const net = simulatePortfolio(policy, events);
  // Resolve each cash-allocation buy once using the net execution price/cost
  // contract. Reuse that exact quantity in the gross comparison: otherwise a
  // zero-cost gross arm buys more shares than the net arm and the alleged
  // "transaction-cost effect" also contains a sizing effect. Keep rejected
  // allocation events intact in the gross arm so a cost-sensitive difference
  // in accepted event sets still fails closed below.
  const netEntryQuantity = new Map(net.fills
    .filter((fill) => fill.kind === "entry")
    .map((fill) => [fill.eventId, fill.quantity]));
  const grossEvents = events.map((event) => {
    const resolvedQuantity = event.kind === "entry" ? netEntryQuantity.get(event.id) : undefined;
    if (resolvedQuantity != null) {
      return { ...event, quantity: resolvedQuantity, cashAllocation: undefined, costPct: 0 };
    }
    return { ...event, costPct: 0 };
  });
  const gross = simulatePortfolio(policy, grossEvents);
  const signature = (rows: SimulationRejection[]) => rows.map((row) => `${row.eventId}:${row.reason}`).sort().join("|");
  if (signature(net.rejections) !== signature(gross.rejections)) throw new Error("Gross and net arms accepted different event sets.");
  const fillSignature = (fills: SimulatedFill[]) => fills
    .map((fill) => `${fill.eventId}:${fill.kind}:${fill.quantity}`)
    .sort();
  if (canonicalize(fillSignature(net.fills)) !== canonicalize(fillSignature(gross.fills))) {
    throw new Error("Gross and net arms must use identical fill events and quantities.");
  }
  return {
    grossNav: navFor(policy, gross.fills, marks),
    netNav: navFor(policy, net.fills, marks),
    grossFills: gross.fills,
    netFills: net.fills,
    rejections: net.rejections,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort(); const b = [...right].sort();
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function blockDeltas(baseline: NavSeries, variant: NavSeries, blockLength: number): { values: number[]; trailing: number } {
  if (baseline.points.length !== variant.points.length || baseline.points.some((p, i) => p.session !== variant.points[i]?.session)) {
    throw new Error("Baseline and variant must have the identical ordered market-session window.");
  }
  const returns: Array<{ b: number; v: number }> = [];
  for (let i = 1; i < baseline.points.length; i++) {
    const b0 = baseline.points[i - 1].nav, b1 = baseline.points[i].nav;
    const v0 = variant.points[i - 1].nav, v1 = variant.points[i].nav;
    if (![b0, b1, v0, v1].every(finitePositive)) throw new Error("Portfolio NAV contains a missing/non-positive mark.");
    returns.push({ b: b1 / b0, v: v1 / v0 });
  }
  const count = Math.floor(returns.length / blockLength);
  const values: number[] = [];
  for (let block = 0; block < count; block++) {
    const slice = returns.slice(block * blockLength, (block + 1) * blockLength);
    const b = slice.reduce((value, row) => value * row.b, 1);
    const v = slice.reduce((value, row) => value * row.v, 1);
    values.push((v - b) * 100);
  }
  return { values, trailing: returns.length - count * blockLength };
}

function studentTCritical95(df: number): number {
  const smallDf = [0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  if (df < 1) return Number.NaN;
  if (df < smallDf.length) return smallDf[df];
  return 1.96 + (1.96 ** 3 + 1.96) / (4 * df) + (5 * 1.96 ** 5 + 16 * 1.96 ** 3 + 3 * 1.96) / (96 * df ** 2);
}

function blockStats(values: number[]) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const se = Math.sqrt(variance / values.length);
  const critical = studentTCritical95(values.length - 1);
  return { mean, lower: mean - critical * se, upper: mean + critical * se, t: se > 0 ? mean / se : null };
}

/** Shared t/CI calculation for paired, non-overlapping portfolio-return blocks. */
export const pairedBlockStats = blockStats;

function turnover(fills: SimulatedFill[], initialNav: number): number {
  return fills.reduce((sum, fill) => sum + fill.gross, 0) / initialNav * 100;
}

/** Strict shared-accounting seam. It calculates no candidate policy itself. */
export function runPairedPortfolioReplay(input: PairedPortfolioReplayInput): PairedPortfolioReplayResult {
  if (!input.programId.trim() || !input.programVersion.trim() || !input.baselineVersion.trim() || !input.costModelVersion.trim()) throw new Error("Program, policy and cost versions are required.");
  if (input.policy.market !== input.market) throw new Error("Portfolio simulation and attribution markets must match.");
  if (input.comparisonType !== "matched_replay" && input.comparisonType !== "paper_cohort") throw new Error("Operational-only programs cannot claim portfolio performance.");
  if (input.asOfSession < input.windowEnd || input.windowStart > input.windowEnd) throw new Error("Attribution window/as-of dates are invalid.");
  if (!Number.isInteger(input.independenceBlockSessions) || input.independenceBlockSessions < 1) throw new Error("Independent block length must be a positive integer.");
  if (!input.baselineDecisionIds.length || !sameStrings(input.baselineDecisionIds, input.variantDecisionIds) || new Set(input.baselineDecisionIds).size !== input.baselineDecisionIds.length) {
    throw new Error("Baseline and variant must use the exact same unique point-in-time decision population.");
  }
  const sharedDecisions = new Set(input.baselineDecisionIds);
  for (const event of [...input.baselineEvents, ...input.variantEvents]) {
    if (event.kind === "entry" && (!event.decisionId || !sharedDecisions.has(event.decisionId))) {
      throw new Error("Every replay entry must link to a decision in the identical matched candidate population.");
    }
  }
  const sessions = input.expectedSessions;
  if (sessions.length < 3 || sessions[0] !== input.windowStart || sessions[sessions.length - 1] !== input.windowEnd || sessions.some((s, i) => i > 0 && s <= sessions[i - 1])) throw new Error("Expected sessions must be the complete ordered market-local window including both endpoints.");
  const dayBeforeStart = new Date(`${input.windowStart}T12:00:00Z`);
  dayBeforeStart.setUTCDate(dayBeforeStart.getUTCDate() - 1);
  const calendarSessions = expectedMarketSessionsBetween(
    input.market,
    dayBeforeStart.toISOString().slice(0, 10),
    input.windowEnd,
  );
  if (canonicalize(sessions) !== canonicalize(calendarSessions)) {
    throw new Error("Expected sessions do not equal the complete regular-session calendar window; missing or extra market dates invalidate attribution.");
  }
  if (input.marks.length !== sessions.length || input.marks.some((mark, i) => mark.session !== sessions[i] || !finitePositive(mark.benchClose))) throw new Error("Benchmark and price marks must cover every expected market session exactly once.");
  for (const event of [...input.baselineEvents, ...input.variantEvents]) {
    if (!sessions.includes(event.session) || event.session <= input.windowStart || event.session > input.windowEnd) throw new Error("Replay event falls outside the post-anchor common window.");
  }
  const baseline = runArm(input.policy, input.baselineEvents, input.marks);
  const variant = runArm(input.policy, input.variantEvents, input.marks);
  if (!baseline.netFills.length && !variant.netFills.length && !(input.policy.initialPositions?.length)) {
    throw new Error("Neither replay arm produced a fill or started with holdings; empty cash-only books cannot claim portfolio P&L attribution.");
  }
  for (const nav of [baseline.grossNav, baseline.netNav, variant.grossNav, variant.netNav]) {
    if (nav.unpricedSessions) throw new Error("A held symbol lacks a same-session price mark; measured attribution is refused.");
    if (nav.points.some((p) => p.benchNav == null)) throw new Error("Benchmark marks are incomplete for one or both arms.");
  }
  const blocks = blockDeltas(baseline.netNav, variant.netNav, input.independenceBlockSessions);
  if (blocks.values.length < 2) throw new Error(`Only ${blocks.values.length} complete non-overlapping independent return blocks; need at least 2.`);
  const stats = blockStats(blocks.values);
  const bGross = baseline.grossNav.totalReturnPct, vGross = variant.grossNav.totalReturnPct;
  const bNet = baseline.netNav.totalReturnPct, vNet = variant.netNav.totalReturnPct;
  const benchmarkReturn = baseline.netNav.benchTotalReturnPct;
  if ([bGross, vGross, bNet, vNet, benchmarkReturn].some((value) => value == null || !Number.isFinite(value))) throw new Error("Attribution endpoints or same-window benchmark return are incomplete.");
  const grossDelta = vGross! - bGross!;
  const netDelta = vNet! - bNet!;
  const row: Omit<UpgradePathAttributionRow, "created_at"> = {
    program_id: input.programId,
    market: input.market,
    program_version: input.programVersion,
    baseline_version: input.baselineVersion,
    comparison_type: input.comparisonType,
    state: "measured",
    return_basis: "gross_and_net",
    as_of_session: input.asOfSession,
    window_start: input.windowStart,
    window_end: input.windowEnd,
    baseline_portfolio_return_pct: bGross!,
    variant_portfolio_return_pct: vGross!,
    baseline_net_portfolio_return_pct: bNet!,
    variant_net_portfolio_return_pct: vNet!,
    benchmark_return_pct: benchmarkReturn!,
    incremental_return_pct: grossDelta,
    net_incremental_return_pct: netDelta,
    benchmark_relative_incremental_return_pct: (vNet! - benchmarkReturn!) - (bNet! - benchmarkReturn!),
    drawdown_delta_pct: variant.netNav.maxDrawdownPct - baseline.netNav.maxDrawdownPct,
    turnover_pct: turnover(variant.netFills, baseline.netNav.points[0].nav),
    independent_sessions: blocks.values.length,
    ci_lower_pct: stats.lower,
    ci_upper_pct: stats.upper,
    t_statistic: stats.t,
    matched_population_hash: digest([...input.baselineDecisionIds].sort()),
    input_snapshot_hash: digest({ pointInTimeInputs: input.pointInTimeInputs, policy: input.policy, baselineEvents: input.baselineEvents, variantEvents: input.variantEvents, marks: input.marks, expectedSessions: sessions, costModelVersion: input.costModelVersion }),
    cost_model_version: input.costModelVersion,
    validity_reason: null,
    constraints: {
      same_market: true, same_window: true, same_population: true, non_overlapping_sessions: true, cost_basis: "net",
      benchmark_market: input.market, independence_block_sessions: input.independenceBlockSessions,
      confidence_interval: "95% two-sided Student-t on non-overlapping block active-return differences",
      turnover_formula: "variant filled notional / initial NAV * 100",
    },
  };
  return {
    row,
    diagnostics: {
      baselineFills: baseline.netFills.length,
      variantFills: variant.netFills.length,
      baselineRejections: baseline.rejections,
      variantRejections: variant.rejections,
      unpricedSessions: { baseline: baseline.netNav.unpricedSessions, variant: variant.netNav.unpricedSessions },
      completeIndependentBlocks: blocks.values.length,
      discardedTrailingSessions: blocks.trailing,
    },
  };
}
