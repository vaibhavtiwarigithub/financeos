// W4 — NAV mark provenance and a NAV invariant that can actually fail.
//
// Why this exists.
//
// 1. The old "invariant" in position-monitor computed `newNav` and
//    `invariantExpected` from the SAME reduce over the SAME array and then
//    compared them. `invariantDiff` was structurally zero: the branch was
//    unreachable and the check could only ever report green. It was one of the
//    five checks in the 2026-08-16 incident that were shaped like verification
//    and were not verification.
//
// 2. Positions were only re-priced when a fresh quote existed. When one did
//    not, the position silently kept whatever `current_price` a previous run
//    wrote, so NAV blended marks of different ages with no record of which was
//    which. `paper_positions.current_price` is mutated in place and
//    `paper_nav_history` keeps aggregates only, so a bad mark is unrecoverable
//    the moment the next run overwrites it. On 2026-08-12 NAV moved +2.70% then
//    -2.97% while the 9 held positions actually moved -0.48%; the provenance
//    needed to attribute that was never written and never can be.
//
// The contracts below are deliberately *independent* of the value they check:
// `reconcilePersistedNav` compares numbers that were READ BACK OUT OF THE
// DATABASE against a NAV computed locally from cash plus the mark set. A
// self-comparison cannot express that, which is exactly why the old one could
// not fail.

export type Market = "us" | "india";

/** How a mark was obtained. Anything that is not `live_quote` is stale weight. */
export type MarkProvenance =
  /** A quote fetched this run that passed the adapter's freshness rule. */
  | "live_quote"
  /** No fresh quote: carried the `current_price` an earlier run persisted. */
  | "carry_forward"
  /** Never priced at all: falls back to entry cost, so NAV shows no P&L. */
  | "entry_cost";

export interface PositionMarkInput {
  positionId: string;
  symbol: string;
  market: Market;
  qty: number;
  avgCost: number;
  /** `paper_positions.current_price` as persisted before this run. */
  persistedPrice?: number | null;
  /** `paper_positions.updated_at` — when that persisted price was written. */
  persistedAt?: string | null;
  /** Price accepted from a fresh quote this run, if any. */
  livePrice?: number | null;
  /** Provider that produced the live quote (`massive`, `yahoo`, ...). */
  liveSource?: string | null;
  /** The quote's OWN observation time, not the time we read it. */
  liveObservedAt?: string | null;
}

export interface PositionMark {
  positionId: string;
  symbol: string;
  market: Market;
  qty: number;
  mark: number;
  /** Provider name for a live mark; otherwise the fallback that produced it. */
  source: string;
  /** Provider/market-session timestamp for the mark. Null when unknown. */
  observedAt: string | null;
  provenance: MarkProvenance;
  /** True for anything that is not a fresh quote taken this run. */
  stale: boolean;
  /** Age of the mark in days, when an observation time is known. */
  ageDays: number | null;
  /** Human-readable justification; persisted on the ledger row. */
  reason: string;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Resolve exactly one mark for an open position, and say where it came from.
 *
 * There is no silent fallback: every branch stamps a provenance and a reason,
 * so a NAV built from these marks can always be decomposed afterwards.
 */
export function buildPositionMark(input: PositionMarkInput, now = new Date()): PositionMark {
  const base = {
    positionId: input.positionId,
    symbol: input.symbol,
    market: input.market,
    qty: num(input.qty) ?? 0,
  };

  const live = num(input.livePrice);
  if (live != null && live > 0) {
    const observedAt = input.liveObservedAt ?? null;
    const observedMs = observedAt ? Date.parse(observedAt) : NaN;
    return {
      ...base,
      mark: live,
      source: input.liveSource || "unknown_live",
      observedAt,
      provenance: "live_quote",
      stale: false,
      ageDays: Number.isFinite(observedMs) ? (now.getTime() - observedMs) / 86_400_000 : null,
      reason: `fresh quote from ${input.liveSource || "unknown"}`,
    };
  }

  const carried = num(input.persistedPrice);
  if (carried != null && carried > 0) {
    const observedAt = input.persistedAt ?? null;
    const observedMs = observedAt ? Date.parse(observedAt) : NaN;
    const ageDays = Number.isFinite(observedMs) ? (now.getTime() - observedMs) / 86_400_000 : null;
    return {
      ...base,
      mark: carried,
      source: "paper_positions.current_price",
      observedAt,
      provenance: "carry_forward",
      stale: true,
      ageDays,
      reason: ageDays == null
        ? "no fresh quote; carried last persisted mark (age unknown)"
        : `no fresh quote; carried last persisted mark (${ageDays.toFixed(1)}d old)`,
    };
  }

  const cost = num(input.avgCost) ?? 0;
  return {
    ...base,
    mark: cost,
    source: "paper_positions.avg_cost",
    observedAt: null,
    provenance: "entry_cost",
    stale: true,
    ageDays: null,
    reason: "never priced: no fresh quote and no persisted mark; NAV carries entry cost",
  };
}

export interface MarkCoverage {
  positions: number;
  /** Σ qty over all open positions in this market. */
  totalQty: number;
  /** Σ qty priced from a fresh quote this run. */
  liveQty: number;
  /** Σ qty priced from a previous run's persisted mark. */
  carryForwardQty: number;
  /** Σ qty with no mark at all — carried at entry cost. */
  entryCostQty: number;
  /** Market value carried on stale (non-live) marks. */
  staleValue: number;
  /** Stale value as a share of total position value. Null when value is zero. */
  staleValuePct: number | null;
  /** Positions whose qty or mark is not a usable positive number. */
  unmarked: string[];
}

/** Explicit, reportable accounting of how much of NAV is stale weight. */
export function summariseMarkCoverage(marks: PositionMark[]): MarkCoverage {
  const cov: MarkCoverage = {
    positions: marks.length,
    totalQty: 0, liveQty: 0, carryForwardQty: 0, entryCostQty: 0,
    staleValue: 0, staleValuePct: null, unmarked: [],
  };
  let totalValue = 0;
  for (const m of marks) {
    const value = m.qty * m.mark;
    cov.totalQty += m.qty;
    totalValue += value;
    if (m.provenance === "live_quote") cov.liveQty += m.qty;
    else if (m.provenance === "carry_forward") cov.carryForwardQty += m.qty;
    else cov.entryCostQty += m.qty;
    if (m.stale) cov.staleValue += value;
    if (!(m.qty > 0) || !(m.mark > 0)) cov.unmarked.push(m.symbol);
  }
  cov.staleValuePct = totalValue > 0 ? (cov.staleValue / totalValue) * 100 : null;
  return cov;
}

/** Mark-to-market of a mark set. The single definition NAV is built from. */
export function positionsValueFromMarks(marks: PositionMark[]): number {
  return marks.reduce((sum, m) => sum + m.qty * m.mark, 0);
}

/** Canonical NAV for one already market-scoped pool and its sourced marks. */
export function navFromMarks(cash: number, marks: PositionMark[]): number {
  return cash + positionsValueFromMarks(marks);
}

export interface NavCheck {
  name: string;
  ok: boolean;
  expected: number | null;
  actual: number | null;
  diff: number | null;
  tolerance: number;
  detail: string;
}

export interface NavReconciliation {
  ok: boolean;
  navFromMarks: number;
  positionsValue: number;
  coverage: MarkCoverage;
  checks: NavCheck[];
  violations: string[];
}

export interface NavReconcileInput {
  market: Market;
  /** Cash this run believes the pool holds. */
  cash: number;
  marks: PositionMark[];
  /** `paper_portfolio.nav` RE-READ from the database after the write. */
  persistedPortfolioNav: number | null | undefined;
  /** `paper_portfolio.cash_balance` re-read after the write. */
  persistedPortfolioCash: number | null | undefined;
  /** `paper_performance.nav` for today's row, re-read after the write. */
  persistedPerformanceNav: number | null | undefined;
  /** seed - Σ open cost + Σ realized. Optional; skipped when unavailable. */
  ledgerCash?: number | null;
}

const tolFor = (v: number) => Math.max(0.01, Math.abs(v) * 1e-6);

/**
 * Assert the persisted book agrees with the marks it was supposedly built from.
 *
 * Every check reads one side out of the database and computes the other side
 * here. That asymmetry is the whole point: it is what makes a regression —
 * a dropped write, a column rename, a partial upsert, a mark that never made it
 * into NAV — produce a failing check instead of a tautology.
 */
export function reconcilePersistedNav(input: NavReconcileInput): NavReconciliation {
  const positionsValue = positionsValueFromMarks(input.marks);
  const expectedNav = navFromMarks(input.cash, input.marks);
  const coverage = summariseMarkCoverage(input.marks);
  const checks: NavCheck[] = [];

  const compare = (name: string, expected: number, actual: number | null | undefined, detail: string) => {
    const a = actual == null || !Number.isFinite(Number(actual)) ? null : Number(actual);
    const tolerance = tolFor(expected);
    if (a == null) {
      checks.push({ name, ok: false, expected, actual: null, diff: null, tolerance,
        detail: `${detail} — value absent after write (the write did not land)` });
      return;
    }
    const diff = Math.abs(a - expected);
    checks.push({ name, ok: diff <= tolerance, expected, actual: a, diff, tolerance, detail });
  };

  compare("paper_portfolio.nav", expectedNav, input.persistedPortfolioNav,
    "persisted portfolio NAV vs cash + mark-to-market");
  compare("paper_portfolio.cash_balance", input.cash, input.persistedPortfolioCash,
    "persisted cash vs the cash this run credited");
  compare("paper_performance.nav", expectedNav, input.persistedPerformanceNav,
    "persisted EOD performance NAV vs cash + mark-to-market");
  if (input.ledgerCash != null && Number.isFinite(input.ledgerCash)) {
    // Wider tolerance: the ledger identity is an independent derivation over
    // realized P&L, so cent-level rounding across many closes is expected.
    const tolerance = Math.max(1, Math.abs(input.ledgerCash) * 0.005);
    const diff = Math.abs(input.cash - input.ledgerCash);
    checks.push({
      name: "cash_ledger_identity", ok: diff <= tolerance,
      expected: input.ledgerCash, actual: input.cash, diff, tolerance,
      detail: "cash vs seed - Σ open cost + Σ realized",
    });
  }

  // Contract: every open qty carries a usable mark. A zero/NaN mark silently
  // removes a position from NAV, which is precisely the class of error the
  // old self-comparison could not see.
  checks.push({
    name: "mark_coverage", ok: coverage.unmarked.length === 0,
    expected: 0, actual: coverage.unmarked.length, diff: coverage.unmarked.length, tolerance: 0,
    detail: coverage.unmarked.length
      ? `open qty with no usable mark: ${coverage.unmarked.join(", ")}`
      : "every open qty has a usable mark",
  });

  const violations = checks.filter(c => !c.ok).map(c =>
    `${c.name}: expected ${c.expected ?? "n/a"}, got ${c.actual ?? "absent"}` +
    (c.diff != null ? ` (drift ${c.diff.toFixed(4)} > tol ${c.tolerance.toFixed(4)})` : "") +
    ` — ${c.detail}`);

  return { ok: violations.length === 0, navFromMarks: expectedNav, positionsValue, coverage, checks, violations };
}

/** Row shape for the append-only `paper_position_marks` ledger. */
export function markLedgerRow(mark: PositionMark, meta: { runId: string; sessionDate: string }) {
  return {
    run_id: meta.runId,
    session_date: meta.sessionDate,
    market: mark.market,
    position_id: mark.positionId,
    symbol: mark.symbol,
    qty: mark.qty,
    mark_price: mark.mark,
    source: mark.source,
    observed_at: mark.observedAt,
    provenance: mark.provenance,
    stale: mark.stale,
    age_days: mark.ageDays,
    reason: mark.reason,
  };
}
