// Alpha Diagnostic Lab — pure diagnostic cores (A0-A3).
//
// READ-ONLY. No provider call, no money-path import, no mutation. Every export
// here is a pure function over already-persisted ledger rows so it can be tested
// without a database and cannot reach production state by accident.

import {
  type DiagnosticFinding,
  type DiagnosticMarket,
  type DiagnosticSample,
  sampleStatus,
} from "./alpha-diagnostic-contract";

const METRIC_VERSION = "alpha_diagnostics_v1";

// ── A0: data truth ───────────────────────────────────────────────────────────

export interface NavRow {
  date: string;
  nav: number | null;
  cashBalance: number | null;
  positionsValue: number | null;
  benchNav: number | null;
  benchSessionDate: string | null;
  benchSource: string | null;
}

export interface A0Invariant {
  id: string;
  ok: boolean;
  detail: string;
  offendingDates: string[];
}

/**
 * Assert the invariants every later conclusion silently assumes.
 *
 * This runs FIRST and gates everything. The 2026-08 incidents that motivated the
 * Lab were all of this shape: a benchmark stamped with the wrong session, a NAV
 * that did not reconcile, a mark carried forward and presented as live. Each
 * produced a confident performance number built on a broken input.
 */
export function runA0DataTruth(
  market: DiagnosticMarket,
  rows: NavRow[],
  opts: { navTolerance?: number } = {},
): { finding: DiagnosticFinding; invariants: A0Invariant[] } {
  const tol = opts.navTolerance ?? 0.01;
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

  const navMismatch: string[] = [];
  const benchSessionMismatch: string[] = [];
  const benchWithoutProvenance: string[] = [];
  const nonPositiveNav: string[] = [];

  for (const r of sorted) {
    const nav = Number(r.nav);
    const cash = Number(r.cashBalance);
    const pos = Number(r.positionsValue);
    if (Number.isFinite(nav) && Number.isFinite(cash) && Number.isFinite(pos)) {
      if (Math.abs(cash + pos - nav) > tol) navMismatch.push(r.date);
    }
    if (Number.isFinite(nav) && nav <= 0) nonPositiveNav.push(r.date);
    if (r.benchNav != null) {
      // A benchmark level may only be joined to a NAV row for the SAME session.
      if (r.benchSessionDate !== r.date) benchSessionMismatch.push(r.date);
      // An unattributed benchmark cannot be audited later, which is exactly how
      // a provisional Yahoo value passed as settled for nine sessions.
      if (!r.benchSource || r.benchSource.trim() === "") benchWithoutProvenance.push(r.date);
    }
  }

  const invariants: A0Invariant[] = [
    { id: "nav_reconciles", ok: navMismatch.length === 0,
      detail: `cash + positions must equal nav within ${tol}`, offendingDates: navMismatch },
    { id: "nav_positive", ok: nonPositiveNav.length === 0,
      detail: "nav must be positive", offendingDates: nonPositiveNav },
    { id: "bench_session_matches_row", ok: benchSessionMismatch.length === 0,
      detail: "bench_session_date must equal the row's date", offendingDates: benchSessionMismatch },
    { id: "bench_has_provenance", ok: benchWithoutProvenance.length === 0,
      detail: "a stored benchmark level must name its source", offendingDates: benchWithoutProvenance },
  ];

  const failed = invariants.filter(i => !i.ok);
  const sample: DiagnosticSample = { nRows: sorted.length, nDates: sorted.length, nSymbols: 0 };

  return {
    invariants,
    finding: {
      market,
      testId: "A0",
      cohort: "accounting",
      window: { from: sorted[0]?.date ?? "", to: sorted[sorted.length - 1]?.date ?? "" },
      sample,
      coverage: sorted.length === 0 ? 0 : 1,
      metricVersion: METRIC_VERSION,
      // A0 is the one test that reports `fail`, not `data_invalid`: it IS the
      // data-truth check, and resolveVerdict turns an A0 failure into a
      // run-level data_invalid.
      status: sorted.length === 0 ? "insufficient_evidence" : failed.length > 0 ? "fail" : "pass",
      reason: sorted.length === 0
        ? "No NAV rows in window."
        : failed.length > 0
          ? `Failed invariants: ${failed.map(f => `${f.id} (${f.offendingDates.length} session(s))`).join("; ")}. No downstream value may be given a pass/fail reading.`
          : "All data-truth invariants hold for the window.",
      metrics: {
        invariants: invariants.map(i => ({ id: i.id, ok: i.ok, offending: i.offendingDates.length })),
        firstOffendingDates: failed.flatMap(f => f.offendingDates.slice(0, 5)),
      },
    },
  };
}

// ── A1: alpha funnel ─────────────────────────────────────────────────────────

export type FunnelStage = "scored" | "entry_eligible" | "selected" | "filled" | "closed";
export const FUNNEL_STAGES: FunnelStage[] = ["scored", "entry_eligible", "selected", "filled", "closed"];

export interface FunnelRow {
  date: string;
  symbol: string;
  stage: FunnelStage;
  /** Benchmark-neutral forward return at the requested horizon, if matured. */
  benchmarkNeutralReturn: number | null;
  /** Deterministic reason this candidate went no further. */
  attritionReason: string | null;
}

/**
 * Locate WHERE alpha is lost: at discovery, in ranking, or between eligibility
 * and execution. The mean benchmark-neutral return at each stage answers a
 * question a single headline number cannot — if `scored` already has no edge,
 * no downstream repair can create one.
 */
export function runA1Funnel(
  market: DiagnosticMarket,
  rows: FunnelRow[],
  horizonDays: number,
  minDates: number,
): DiagnosticFinding {
  const stageIndex = new Map(FUNNEL_STAGES.map((s, i) => [s, i]));
  const byStage = new Map<FunnelStage, FunnelRow[]>();
  for (const s of FUNNEL_STAGES) byStage.set(s, []);
  for (const r of rows) {
    // A row at stage N is, by construction, also a member of every earlier
    // stage. Counting only the terminal stage would understate the funnel.
    const reached = stageIndex.get(r.stage);
    if (reached == null) continue;
    for (let i = 0; i <= reached; i++) byStage.get(FUNNEL_STAGES[i])!.push(r);
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const stages = FUNNEL_STAGES.map(stage => {
    const list = byStage.get(stage)!;
    const withLabel = list.filter(r => r.benchmarkNeutralReturn != null);
    return {
      stage,
      count: list.length,
      labelled: withLabel.length,
      coverage: list.length === 0 ? 0 : withLabel.length / list.length,
      meanBenchmarkNeutralReturn: mean(withLabel.map(r => r.benchmarkNeutralReturn as number)),
    };
  });

  const attrition: Record<string, number> = {};
  for (const r of rows) {
    if (!r.attritionReason) continue;
    attrition[r.attritionReason] = (attrition[r.attritionReason] ?? 0) + 1;
  }

  const dates = new Set(rows.map(r => r.date));
  const sample: DiagnosticSample = {
    nRows: rows.length,
    nDates: dates.size,
    nSymbols: new Set(rows.map(r => r.symbol)).size,
    horizonDays,
  };
  const gate = sampleStatus(sample, minDates);
  const scored = stages[0];

  return {
    market, testId: "A1", cohort: "learning",
    window: { from: minOf(rows.map(r => r.date)), to: maxOf(rows.map(r => r.date)) },
    sample,
    coverage: scored.coverage,
    metricVersion: METRIC_VERSION,
    status: gate.status,
    reason: gate.ok
      ? "Stage-by-stage benchmark-neutral return. Descriptive: it locates attrition, it does not license a policy change."
      : gate.reason,
    metrics: { horizonDays, stages, attrition },
  };
}

// ── A2: entry selection ──────────────────────────────────────────────────────

export interface SelectionRow {
  date: string;
  symbol: string;
  score: number;
  forwardReturn: number;
}

/**
 * Top-minus-bottom quintile spread on benchmark-neutral forward return.
 *
 * Reported ALONGSIDE rank IC, never instead of it: IC says the ranking
 * correlates, the quintile spread says the ranking is worth acting on. A
 * positive IC with a flat spread is a signal that cannot be traded.
 */
export function quintileSpread(rows: SelectionRow[]): {
  spread: number | null; topMean: number | null; bottomMean: number | null; perBucket: number[];
} {
  const usable = rows.filter(r => Number.isFinite(r.score) && Number.isFinite(r.forwardReturn));
  if (usable.length < 5) return { spread: null, topMean: null, bottomMean: null, perBucket: [] };
  const sorted = [...usable].sort((a, b) => a.score - b.score);
  const n = sorted.length;
  const buckets: SelectionRow[][] = [[], [], [], [], []];
  for (let i = 0; i < n; i++) {
    // Floor-based assignment keeps buckets balanced to within one row and never
    // produces an out-of-range index at i === n - 1.
    const b = Math.min(4, Math.floor((i * 5) / n));
    buckets[b].push(sorted[i]);
  }
  const mean = (xs: SelectionRow[]) => (xs.length ? xs.reduce((a, r) => a + r.forwardReturn, 0) / xs.length : null);
  const perBucket = buckets.map(b => mean(b) ?? Number.NaN);
  const bottomMean = perBucket[0];
  const topMean = perBucket[4];
  const spread = Number.isFinite(topMean) && Number.isFinite(bottomMean) ? topMean - bottomMean : null;
  return { spread, topMean: nOrNull(topMean), bottomMean: nOrNull(bottomMean), perBucket };
}

// ── A3: payoff geometry ──────────────────────────────────────────────────────

export interface ClosedLot {
  symbol: string;
  market: DiagnosticMarket;
  realizedPnl: number;
  pnlPct: number;
  /** Max favourable / adverse excursion over the lot's own horizon, as fractions. */
  mfe: number | null;
  mae: number | null;
  exitReason: string | null;
}

/**
 * Both profit factors are required and they answer different questions.
 *
 * `percentProfitFactor` measures POLICY quality independent of position size.
 * `currencyProfitFactor` measures the real capital outcome. A positive average
 * trade with a currency profit factor below 1 is direct evidence that SIZING
 * damaged the book — the policy picked winners and the allocation lost money on
 * them. Reporting only one of these hides that entire failure mode.
 */
export function runA3Payoff(market: DiagnosticMarket, lots: ClosedLot[]): DiagnosticFinding {
  const wins = lots.filter(l => l.realizedPnl > 0);
  const losses = lots.filter(l => l.realizedPnl < 0);
  const pctWins = lots.filter(l => l.pnlPct > 0);
  const pctLosses = lots.filter(l => l.pnlPct < 0);

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const ratio = (num: number, den: number) => (den > 0 ? num / den : null);

  const currencyProfitFactor = ratio(sum(wins.map(l => l.realizedPnl)), Math.abs(sum(losses.map(l => l.realizedPnl))));
  const percentProfitFactor = ratio(sum(pctWins.map(l => l.pnlPct)), Math.abs(sum(pctLosses.map(l => l.pnlPct))));

  // Capture and giveback are only defined where the lot actually went favourable.
  const withMfe = lots.filter(l => l.mfe != null && (l.mfe as number) > 0);
  const captureRatios = withMfe.map(l => (l.pnlPct / 100) / (l.mfe as number));
  const givebacks = withMfe.map(l => (l.mfe as number) - l.pnlPct / 100);
  const priorPositiveLosers = lots.filter(l => l.pnlPct < 0 && l.mfe != null && (l.mfe as number) > 0).length;

  const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);
  const sample: DiagnosticSample = {
    nRows: lots.length, nDates: lots.length, nSymbols: new Set(lots.map(l => l.symbol)).size,
  };

  return {
    market, testId: "A3", cohort: "learning",
    window: { from: "", to: "" },
    sample,
    coverage: lots.length === 0 ? 0 : withMfe.length / lots.length,
    metricVersion: METRIC_VERSION,
    status: lots.length === 0 ? "insufficient_evidence" : "descriptive_only",
    reason: lots.length === 0
      ? "No closed lots in cohort."
      : "Payoff geometry. Descriptive: a profit-factor gap localises damage, it does not authorise a stop/target change.",
    metrics: {
      lots: lots.length,
      winRate: lots.length ? wins.length / lots.length : null,
      currencyProfitFactor,
      percentProfitFactor,
      // The headline diagnostic: policy looks fine, capital does not.
      sizingDamageSuspected:
        percentProfitFactor != null && currencyProfitFactor != null &&
        percentProfitFactor >= 1 && currencyProfitFactor < 1,
      meanCaptureRatio: mean(captureRatios),
      meanGiveback: mean(givebacks),
      priorPositiveLosers,
      priorPositiveLoserShare: losses.length ? priorPositiveLosers / losses.length : null,
    },
  };
}

function nOrNull(v: number): number | null { return Number.isFinite(v) ? v : null; }
function minOf(xs: string[]): string { return xs.length ? xs.reduce((a, b) => (a < b ? a : b)) : ""; }
function maxOf(xs: string[]): string { return xs.length ? xs.reduce((a, b) => (a > b ? a : b)) : ""; }
