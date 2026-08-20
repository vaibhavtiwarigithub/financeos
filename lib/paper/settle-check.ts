// Next-day settlement check for US paper marks.
//
// WHY. The US PositionMonitor runs 16:15 ET and marks from Yahoo, because that
// is the only vendor carrying the just-closed session at that hour (measured
// 2026-08-19/20: Massive grouped publishes NEXT-DAY, Massive /prev and
// price_cache still hold the PREVIOUS session, and Alpha Vantage served the
// previous close outright). Yahoo cannot corroborate Yahoo, so those marks are
// written `uncorroborated` — honest, but single-sourced on the money path.
//
// The grouped feed (`/v2/aggs/grouped/...`, 12,549 tickers in ONE entitled call)
// becomes available the following morning and IS independent. This pass compares
// yesterday's marks against it and reports the drift.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not rewrite `paper_performance.nav`,
// `paper_positions.current_price`, or any realized trade. The exits already
// happened at the marked price; restating NAV afterwards would re-decide a past
// session, which is what the frozen-history rule in the Scoring Data-Truth
// Review Protocol forbids. A material drift is TAINTED and reported, so the
// number is labelled untrustworthy rather than quietly replaced.

export interface SettleMark {
  symbol: string;
  qty: number;
  markPrice: number;
  provenance: string;
  source: string;
}

export interface SettleRow {
  symbol: string;
  marked: number;
  settled: number;
  driftPct: number;
  /** Signed NAV impact of this position's drift, in account currency. */
  valueDrift: number;
  beyondTolerance: boolean;
}

export interface SettleResult {
  sessionDate: string;
  compared: number;
  /** Marks with no authoritative close available — NOT counted as agreement. */
  unverifiable: string[];
  rows: SettleRow[];
  worstDriftPct: number;
  /** Σ signed value drift across compared positions. */
  navDrift: number;
  beyond: SettleRow[];
  verdict: "corroborated" | "drift_detected" | "nothing_to_compare";
}

/**
 * Tolerance for a settled-vs-marked comparison.
 *
 * Looser than the intraday cross-check (0.1%) on purpose: Yahoo's 16:15 print is
 * a near-final rather than fully settled close, and a small legitimate revision
 * is expected. Measured 2026-08-19, Yahoo at 16:15 vs the settled close was
 * exact on NVDA and XAR and 0.07% out on KGC. 0.25% flags a real mismarking
 * without firing on ordinary settlement revision.
 */
export const SETTLE_TOLERANCE_PCT = 0.25;

export function compareSettledMarks(
  sessionDate: string,
  marks: readonly SettleMark[],
  settledCloses: Readonly<Record<string, number>>,
  tolerancePct: number = SETTLE_TOLERANCE_PCT,
): SettleResult {
  const rows: SettleRow[] = [];
  const unverifiable: string[] = [];

  for (const m of marks) {
    // Only a mark that CLAIMED to be a live quote is being checked. A
    // carry_forward or entry_cost mark is already labelled stale; re-flagging it
    // here would double-report a known condition.
    if (m.provenance !== "live_quote") continue;
    const settled = settledCloses[m.symbol];
    if (!Number.isFinite(settled) || settled <= 0) { unverifiable.push(m.symbol); continue; }
    if (!Number.isFinite(m.markPrice) || m.markPrice <= 0) { unverifiable.push(m.symbol); continue; }

    const driftPct = ((m.markPrice - settled) / settled) * 100;
    rows.push({
      symbol: m.symbol,
      marked: m.markPrice,
      settled,
      driftPct,
      valueDrift: (m.markPrice - settled) * (Number.isFinite(m.qty) ? m.qty : 0),
      beyondTolerance: Math.abs(driftPct) > tolerancePct,
    });
  }

  const beyond = rows.filter((r) => r.beyondTolerance);
  const worstDriftPct = rows.reduce((w, r) => Math.max(w, Math.abs(r.driftPct)), 0);
  const navDrift = rows.reduce((s, r) => s + r.valueDrift, 0);

  return {
    sessionDate,
    compared: rows.length,
    unverifiable,
    rows,
    worstDriftPct,
    navDrift,
    beyond,
    // An empty comparison is NOT success. "Nothing to compare" and "everything
    // agreed" look identical in a boolean and must never collapse together.
    verdict: rows.length === 0 ? "nothing_to_compare"
      : beyond.length > 0 ? "drift_detected"
      : "corroborated",
  };
}
