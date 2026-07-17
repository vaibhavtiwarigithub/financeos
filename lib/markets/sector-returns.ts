// ─────────────────────────────────────────────────────────────────────────────
// Sector-return honesty layer (display data only — never on the money path).
//
// WHY THIS EXISTS
// `/api/charts/sector-returns?days=N` used to guard on `candles.length < 2`.
// That checks the COUNT of bars, not the SPAN they cover. With only two cached
// sessions in `price_cache`, every window (1W/1M/3M/6M/1Y) selected the SAME
// two bars and returned the SAME one-day move — which the UI then rendered as
// "1Y XLK return +x%". A display asserting a period the data cannot support is
// a false-return bug, not merely missing data.
//
// The rule here: a window may only report a return when the cached history
// actually SPANS that window. Otherwise return null plus an explicit,
// machine-readable reason the UI can turn into "insufficient history for 1Y"
// (what / why / next) rather than a wrong-period number or a bare "—".
//
// This module is pure (no I/O) so the contract is unit-testable in the node
// test env and shared verbatim by the API route and the client components.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * START-EDGE TOLERANCE — how far after the requested cutoff the oldest cached
 * bar may sit and still count as spanning the window.
 *
 * Exact-match is wrong: markets close on weekends and holidays, so a cutoff of
 * `today - 365` routinely lands on a non-trading day and the first real session
 * is 1-3 calendar days later.
 *
 * 4 calendar days is the smallest tolerance that never produces a false
 * negative: the longest run of consecutive non-trading calendar days on US
 * equity markets is 3 (a Friday or Monday holiday adjacent to a weekend, e.g.
 * Good Friday → Sunday, or Saturday → Memorial Day Monday). 4 carries one day
 * of margin for an unscheduled closure without letting a materially shorter
 * window masquerade as a longer one.
 *
 * Worked example (the bug this fixes): cache holds only 2026-07-14 and
 * 2026-07-15. A 1W request has cutoff 2026-07-09; the oldest bar is 5 days
 * later, exceeding the tolerance, so the window reports null. Sessions on
 * 07-09, 07-10 and 07-13 are genuinely missing — this is absence of history,
 * not a market closure.
 */
export const START_GRACE_DAYS = 4;

/**
 * END-EDGE TOLERANCE — how stale the newest cached bar may be before a period
 * return is considered unreportable.
 *
 * The daily fill stores the PREVIOUS completed session, so the newest bar is
 * legitimately 1 day old (up to 4 over a holiday-extended weekend). 7 calendar
 * days carries margin past any real closure; beyond that the fill itself is
 * broken and a "1Y return" ending weeks ago is another false period claim.
 */
export const STALE_GRACE_DAYS = 7;

/**
 * SPAN COVERAGE FLOOR — the fraction of the requested window the cached bars
 * must actually cover (oldest → newest) before a return may be reported.
 *
 * WHY THE START-EDGE GRACE IS NOT ENOUGH (this guard is load-bearing):
 * START_GRACE_DAYS is an ABSOLUTE tolerance, so on a short window it can
 * swallow the window whole. Observed against real prod data on 2026-07-17 with
 * only two cached sessions (07-14, 07-15): the 1W cutoff is 07-10, the oldest
 * bar 07-14 is exactly 4 days later — inside the grace — and the newest bar is
 * 2 days old, so BOTH edge checks passed and a 1-day move was reported as a
 * "1W return" of -1.11%. The absolute grace assumed the 07-10 → 07-14 gap was
 * a market closure; in fact 07-10 and 07-13 were trading days whose bars are
 * simply missing.
 *
 * A relative floor closes that hole: 1 day of span cannot satisfy a 7-day
 * window (1/7 = 0.14). The two checks guard different failure modes and are
 * both required — the absolute grace catches missing EARLY history on long
 * windows (6 months of data must never be labelled 1Y), the relative floor
 * catches DEGENERATE spans on short windows.
 *
 * 0.4 is the calibration. It must sit below the worst legitimate 1W coverage
 * and above the degenerate case:
 *   - Worst legitimate 1W: today is a Monday and the prior Monday was a
 *     holiday, so bars run Tue→Fri while the newest is the Friday close —
 *     span 3 of 7 = 0.43. A floor above this would false-reject a real week.
 *   - Degenerate: the 2-bar cache above, span 1 of 7 = 0.14 — rejected.
 * Long windows clear this trivially (a filled 1Y spans ~364/365 = 0.997) and
 * are policed by the start edge instead.
 */
export const MIN_SPAN_COVERAGE = 0.4;

export type SectorReturnReasonCode =
  | "no_data"
  | "single_bar"
  | "insufficient_history"
  | "stale_cache";

export interface SectorReturnReason {
  code: SectorReturnReasonCode;
  /** Operator-readable what/why/next. Safe to render directly. */
  message: string;
}

export interface SectorReturnRow {
  symbol: string;
  name: string;
  /** Null whenever the cached history cannot support the requested window. */
  returnPct: number | null;
  reason: SectorReturnReason | null;
  latestClose?: number;
  candles: number;
  /** Calendar days actually spanned by the cached bars used for this window. */
  spanDays: number | null;
  oldestDate: string | null;
  latestDate: string | null;
}

export interface Candle {
  date: string;
  close: number;
}

/** Whole calendar days between two YYYY-MM-DD strings (b - a). */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** YYYY-MM-DD `days` before `today`. */
export function cutoffFor(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function periodLabel(days: number): string {
  if (days <= 7) return "1W";
  if (days <= 30) return "1M";
  if (days <= 90) return "3M";
  if (days <= 180) return "6M";
  return "1Y";
}

/**
 * Decide whether `candles` (already filtered to >= cutoff, ascending by date)
 * can support a `days`-long return, and compute it when they can.
 */
export function evaluateWindow(
  candles: Candle[],
  opts: { days: number; today: string },
): Pick<
  SectorReturnRow,
  "returnPct" | "reason" | "latestClose" | "candles" | "spanDays" | "oldestDate" | "latestDate"
> {
  const label = periodLabel(opts.days);
  const cutoff = cutoffFor(opts.today, opts.days);

  if (candles.length === 0) {
    return {
      returnPct: null,
      reason: {
        code: "no_data",
        message:
          `No cached ${label} history — the sector price cache holds no sessions on or after ${cutoff}. ` +
          `The daily fill runs weekdays pre-market and backfills history incrementally; this window populates as bars accumulate.`,
      },
      candles: 0,
      spanDays: null,
      oldestDate: null,
      latestDate: null,
    };
  }

  const oldest = candles[0];
  const latest = candles[candles.length - 1];
  const spanDays = daysBetween(oldest.date, latest.date);

  if (candles.length < 2) {
    return {
      returnPct: null,
      reason: {
        code: "single_bar",
        message:
          `Only one cached session (${oldest.date}) falls inside the ${label} window — a return needs two endpoints. ` +
          `The daily fill runs weekdays pre-market; this window populates as bars accumulate.`,
      },
      candles: candles.length,
      spanDays,
      oldestDate: oldest.date,
      latestDate: latest.date,
    };
  }

  // START EDGE — the oldest bar must sit at or near the requested cutoff.
  // This is the guard the old `candles.length < 2` check was missing: two bars
  // from last week satisfy a count check but cannot span a year.
  const startGap = daysBetween(cutoff, oldest.date);
  if (startGap > START_GRACE_DAYS) {
    return {
      returnPct: null,
      reason: {
        code: "insufficient_history",
        message:
          `Insufficient history for ${label} — the ${label} window starts ${cutoff}, but the oldest cached session is ${oldest.date} ` +
          `(${candles.length} session${candles.length === 1 ? "" : "s"} spanning ${spanDays} day${spanDays === 1 ? "" : "s"}). ` +
          `Reporting a return from these bars would label a ${spanDays}-day move as ${label}. ` +
          `The daily fill backfills history incrementally on weekdays; try a shorter period until this window fills in.`,
      },
      candles: candles.length,
      spanDays,
      oldestDate: oldest.date,
      latestDate: latest.date,
    };
  }

  // SPAN COVERAGE — the bars must actually cover the window. The start-edge
  // check above is absolute and cannot protect a short window on its own (see
  // MIN_SPAN_COVERAGE): a 1-day span must never be reported as a 1W return.
  if (spanDays < opts.days * MIN_SPAN_COVERAGE) {
    return {
      returnPct: null,
      reason: {
        code: "insufficient_history",
        message:
          `Insufficient history for ${label} — the cached sessions (${oldest.date} → ${latest.date}) span only ` +
          `${spanDays} day${spanDays === 1 ? "" : "s"} of the ${opts.days}-day ${label} window. ` +
          `Reporting this would label a ${spanDays}-day move as ${label}. ` +
          `The daily fill backfills history incrementally on weekdays; try a shorter period until this window fills in.`,
      },
      candles: candles.length,
      spanDays,
      oldestDate: oldest.date,
      latestDate: latest.date,
    };
  }

  // END EDGE — the newest bar must be recent enough that the window actually
  // ends near today rather than at some stale point in the past.
  const staleness = daysBetween(latest.date, opts.today);
  if (staleness > STALE_GRACE_DAYS) {
    return {
      returnPct: null,
      reason: {
        code: "stale_cache",
        message:
          `Sector price cache is stale — the newest cached session is ${latest.date}, ${staleness} days before ${opts.today}. ` +
          `A ${label} return ending ${latest.date} would not be a ${label}-to-today return. ` +
          `Check the weekday price-cache fill; the figure returns once fresh bars land.`,
      },
      candles: candles.length,
      spanDays,
      oldestDate: oldest.date,
      latestDate: latest.date,
    };
  }

  return {
    returnPct: ((latest.close - oldest.close) / oldest.close) * 100,
    reason: null,
    latestClose: latest.close,
    candles: candles.length,
    spanDays,
    oldestDate: oldest.date,
    latestDate: latest.date,
  };
}

/**
 * Build the full per-sector row set for a window.
 * `sectors` is the display universe; `bySymbol` the cached bars per symbol.
 */
export function computeSectorReturns(
  sectors: { symbol: string; name: string }[],
  bySymbol: Record<string, Candle[]>,
  opts: { days: number; today: string },
): SectorReturnRow[] {
  return sectors.map((s) => ({
    symbol: s.symbol,
    name: s.name,
    ...evaluateWindow(bySymbol[s.symbol] ?? [], opts),
  }));
}

export interface SectorCoverage {
  withReturn: number;
  total: number;
  /** Dominant reason across sectors lacking a return — drives the UI note. */
  note: string | null;
}

/**
 * Summarise coverage into a single honest note for the UI.
 * Returns note=null only when every sector reported a real return.
 */
export function summariseCoverage(rows: SectorReturnRow[]): SectorCoverage {
  const withReturn = rows.filter((r) => r.returnPct !== null).length;
  if (withReturn === rows.length) return { withReturn, total: rows.length, note: null };

  const blocked = rows.filter((r) => r.returnPct === null && r.reason);
  // Most sector ETFs share a fill cadence, so the modal reason is representative.
  const counts = new Map<SectorReturnReasonCode, number>();
  for (const r of blocked) counts.set(r.reason!.code, (counts.get(r.reason!.code) ?? 0) + 1);
  let dominant: SectorReturnReasonCode | null = null;
  let best = -1;
  for (const [code, n] of counts) if (n > best) { best = n; dominant = code; }

  const sample = blocked.find((r) => r.reason!.code === dominant);
  const scope =
    withReturn === 0
      ? `No sector can report this window.`
      : `${rows.length - withReturn} of ${rows.length} sectors cannot report this window (${blocked.map((r) => r.symbol).join(", ")}).`;

  return {
    withReturn,
    total: rows.length,
    note: `${scope} ${sample?.reason!.message ?? ""}`.trim(),
  };
}
