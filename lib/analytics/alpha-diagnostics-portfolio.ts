// Alpha Diagnostic Lab — A6 portfolio construction, cash and redeployment,
// plus A9 risk geometry.
//
// A6 is the test that makes every other counterfactual honest. A per-trade
// comparison can rank two policies while quietly ignoring that one of them
// needed capital it never had. This runs a CALENDAR with finite cash: exits
// release capital, entries consume it, and a candidate that cannot be funded is
// rejected with a reason rather than silently filled.
//
// READ-ONLY. Composes lib/simulation/portfolio-simulator for fills rather than
// reimplementing accounting.

import {
  simulatePortfolio,
  type SimulationEvent,
  type SimulationPolicy,
} from "@/lib/simulation/portfolio-simulator";
import {
  type DiagnosticFinding,
  type DiagnosticMarket,
} from "./alpha-diagnostic-contract";

const METRIC_VERSION = "alpha_diagnostics_v1";

export interface CalendarEvent {
  session: string;
  symbol: string;
  kind: "entry" | "exit";
  price: number;
  /** Rank among the same session's entries. Lower is better. */
  rank?: number;
  quantity?: number;
  cashAllocation?: number;
}

/**
 * Deterministic same-session ordering: EXITS first, then entries by rank, then
 * lexical symbol as the final tie-breaker.
 *
 * Exits must precede entries or the released capital is not available to the
 * entries that same session, which understates redeployment and makes every
 * cash-drag number pessimistic. The lexical tie-break exists so two runs over
 * the same data cannot order equal-ranked candidates differently — without it
 * the "byte-identical rerun" gate is unsatisfiable in principle.
 */
export function orderSessionEvents(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) => {
    if (a.session !== b.session) return a.session.localeCompare(b.session);
    if (a.kind !== b.kind) return a.kind === "exit" ? -1 : 1;
    const ra = a.rank ?? Number.POSITIVE_INFINITY;
    const rb = b.rank ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return a.symbol.localeCompare(b.symbol);
  });
}

export interface DailyMark {
  session: string;
  /** Symbol -> mark price for that session. */
  prices: Record<string, number>;
  /** Benchmark close for the same session, if known. */
  benchClose?: number | null;
}

export interface PortfolioPoint {
  session: string;
  cash: number;
  positionsValue: number;
  nav: number;
  /** Fraction of NAV actually deployed. The inverse is the cash drag. */
  cashUtilization: number;
  benchNav: number | null;
  drawdownPct: number;
}

export interface PortfolioRunResult {
  points: PortfolioPoint[];
  endingNav: number;
  maxDrawdownPct: number;
  meanCashUtilization: number;
  totalReturnPct: number;
  benchTotalReturnPct: number | null;
  netExcessReturnPp: number | null;
  rejections: { eventId: string; reason: string }[];
}

/**
 * Replay a calendar with finite capital and produce a daily-marked NAV series.
 *
 * Cash correctness is delegated to `simulatePortfolio`, which already refuses an
 * entry it cannot fund. This layer adds the marking, the benchmark pairing and
 * the drawdown/utilisation series the diagnostic needs.
 */
export function runPortfolioCalendar(
  policy: SimulationPolicy,
  events: CalendarEvent[],
  marks: DailyMark[],
): PortfolioRunResult {
  const ordered = orderSessionEvents(events);
  const sessions = [...marks].sort((a, b) => a.session.localeCompare(b.session));

  const points: PortfolioPoint[] = [];
  const rejections: { eventId: string; reason: string }[] = [];
  let peakNav = Number.NEGATIVE_INFINITY;
  let maxDd = 0;

  // Replay incrementally: at each session, apply every event up to and
  // including it, then mark. Re-simulating the prefix keeps the accounting in
  // one authority instead of maintaining a second mutable book here.
  for (const day of sessions) {
    const upto = ordered.filter(e => e.session <= day.session);
    const simEvents: SimulationEvent[] = upto.map((e, i) => ({
      id: `${e.session}:${e.kind}:${e.symbol}:${i}`,
      session: e.session,
      symbol: e.symbol,
      kind: e.kind,
      price: e.price,
      quantity: e.quantity,
      cashAllocation: e.cashAllocation,
    }));
    const sim = simulatePortfolio(policy, simEvents);

    let positionsValue = 0;
    for (const pos of sim.positions) {
      const px = day.prices[pos.symbol];
      // An unmarked open position is NOT worth zero. Fall back to its cost
      // basis so a missing quote cannot masquerade as a total loss.
      //
      // SimulatedPosition.costBasis is PER SHARE, not the total outlay -- the
      // simulator's own exit math reads it as `(price - costBasis) * quantity`.
      // Dividing it by quantity here valued a 50-share position at 10 instead
      // of 500, which a test caught.
      const mark = Number.isFinite(px) && px > 0 ? px : pos.costBasis;
      positionsValue += pos.quantity * mark;
    }
    const nav = sim.endingCash + positionsValue;
    peakNav = Math.max(peakNav, nav);
    const dd = peakNav > 0 ? ((peakNav - nav) / peakNav) * 100 : 0;
    maxDd = Math.max(maxDd, dd);

    points.push({
      session: day.session,
      cash: sim.endingCash,
      positionsValue,
      nav,
      cashUtilization: nav > 0 ? positionsValue / nav : 0,
      benchNav: day.benchClose ?? null,
      drawdownPct: dd,
    });

    if (day === sessions[sessions.length - 1]) {
      for (const r of sim.rejections) rejections.push({ eventId: r.eventId, reason: r.reason });
    }
  }

  const first = points[0];
  const last = points[points.length - 1];
  const totalReturnPct = first && last && first.nav > 0 ? ((last.nav / first.nav) - 1) * 100 : 0;
  const b0 = first?.benchNav ?? null;
  const b1 = last?.benchNav ?? null;
  const benchTotalReturnPct = b0 != null && b1 != null && b0 > 0 ? ((b1 / b0) - 1) * 100 : null;

  return {
    points,
    endingNav: last?.nav ?? policy.initialCash,
    maxDrawdownPct: maxDd,
    meanCashUtilization: points.length ? points.reduce((a, p) => a + p.cashUtilization, 0) / points.length : 0,
    totalReturnPct,
    benchTotalReturnPct,
    netExcessReturnPp: benchTotalReturnPct == null ? null : totalReturnPct - benchTotalReturnPct,
    rejections,
  };
}

/**
 * A6 finding: compare the actual calendar against counterfactual arms.
 *
 * The comparison is PAIRED — same sessions, same starting capital, same name
 * cap — so a difference cannot come from one arm being run over a friendlier
 * window. Drawdown is reported alongside excess return because an arm that wins
 * on return while deepening drawdown is not non-inferior.
 */
export function runA6Portfolio(
  market: DiagnosticMarket,
  arms: { name: string; result: PortfolioRunResult }[],
): DiagnosticFinding {
  const actual = arms.find(a => a.name === "actual") ?? arms[0];
  const sessions = actual?.result.points.length ?? 0;

  const comparisons = arms.map(a => ({
    arm: a.name,
    totalReturnPct: a.result.totalReturnPct,
    netExcessReturnPp: a.result.netExcessReturnPp,
    maxDrawdownPct: a.result.maxDrawdownPct,
    meanCashUtilization: a.result.meanCashUtilization,
    rejections: a.result.rejections.length,
    // Paired against `actual` on the same sessions.
    excessVsActualPp: actual ? a.result.totalReturnPct - actual.result.totalReturnPct : null,
    drawdownVsActualPp: actual ? a.result.maxDrawdownPct - actual.result.maxDrawdownPct : null,
  }));

  // Cash drag: the return the uninvested share did not earn. Reported, never
  // assumed -- an idle sleeve is only a cost when the benchmark actually rose.
  const cashDragPp = actual && actual.result.benchTotalReturnPct != null
    ? (1 - actual.result.meanCashUtilization) * actual.result.benchTotalReturnPct
    : null;

  return {
    market, testId: "A6", cohort: "accounting",
    window: {
      from: actual?.result.points[0]?.session ?? "",
      to: actual?.result.points[sessions - 1]?.session ?? "",
    },
    sample: { nRows: sessions, nDates: sessions, nSymbols: 0 },
    coverage: sessions === 0 ? 0 : 1,
    metricVersion: METRIC_VERSION,
    status: sessions === 0 ? "insufficient_evidence" : "descriptive_only",
    reason: sessions === 0
      ? "No marked sessions to replay."
      : "Paired calendar replay with finite capital. Descriptive: a winning arm still needs drawdown non-inferiority and the robustness gates before it is reviewable.",
    metrics: { sessions, comparisons, cashDragPp },
  };
}

// ── A9: risk geometry by entry vintage ───────────────────────────────────────

export interface GeometryLot {
  symbol: string;
  openedAt: string;
  stopPct: number;
  targetPct: number;
}

/**
 * Reward:risk actually carried by open positions, grouped by entry vintage.
 *
 * Exists because the two books currently carry very different geometry and
 * NOTHING IN THE DECLARED POLICY EXPLAINS IT. Measured 2026-08-28 on open
 * positions, both entirely 2026-08 vintage:
 *
 *   india  14 lots  stop 3.82%  target 14.52%  R:R 6.12
 *   us      8 lots  stop 5.75%  target  7.50%  R:R 1.37
 *
 * India is shaped for "lose small, win big"; the US book is not. Two candidate
 * explanations were tested against production and BOTH FAILED:
 *   - mandate vintage drift: rejected, every open lot is August vintage;
 *   - the n>=60 learned-percentile unlock in resolveExecutionRiskReward:
 *     rejected, both markets clear it (india 98 closed lots, us 73).
 * Meanwhile the indicative trade plans are uniformly 7%/8% in BOTH markets.
 *
 * The cause is therefore UNEXPLAINED and this test exists to keep measuring it
 * rather than to assert a third guess. Grouping by vintage stays because it is
 * the cheapest way to see drift appear if a mandate does change.
 */
export function runA9RiskGeometry(market: DiagnosticMarket, lots: GeometryLot[]): DiagnosticFinding {
  const usable = lots.filter(l => Number.isFinite(l.stopPct) && l.stopPct > 0 && Number.isFinite(l.targetPct));
  const byVintage = new Map<string, GeometryLot[]>();
  for (const l of usable) {
    const key = l.openedAt.slice(0, 7); // YYYY-MM
    byVintage.set(key, [...(byVintage.get(key) ?? []), l]);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const vintages = [...byVintage.entries()].sort().map(([vintage, ls]) => ({
    vintage,
    lots: ls.length,
    meanStopPct: mean(ls.map(l => l.stopPct)),
    meanTargetPct: mean(ls.map(l => l.targetPct)),
    meanRewardRisk: mean(ls.map(l => l.targetPct / l.stopPct)),
  }));

  const overall = mean(usable.map(l => l.targetPct / l.stopPct));
  const distinctTargets = new Set(usable.map(l => Math.round(l.targetPct * 100))).size;

  return {
    market, testId: "A9", cohort: "accounting",
    window: { from: "", to: "" },
    sample: { nRows: usable.length, nDates: byVintage.size, nSymbols: new Set(usable.map(l => l.symbol)).size },
    coverage: lots.length === 0 ? 0 : usable.length / lots.length,
    metricVersion: METRIC_VERSION,
    status: usable.length === 0 ? "insufficient_evidence" : "descriptive_only",
    reason: usable.length === 0
      ? "No positions carrying both a stop and a target."
      : `Reward:risk by entry vintage. ${distinctTargets} distinct target level(s) in the book: a spread here means the average R:R reflects mandate vintage, not current policy.`,
    metrics: { overallRewardRisk: overall, distinctTargetLevels: distinctTargets, vintages },
  };
}
