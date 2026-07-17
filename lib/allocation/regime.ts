// Macro-regime loader for the ALLOCATOR. Deterministic. NO LLM on this path.
//
// This is the allocation-path twin of `fetchMacroScore` in lib/data/scores.ts.
// It deliberately applies the SAME contract to the SAME table (`macro_regime`),
// because both are money-path consumers of one weekly, US-only verdict and must
// not disagree about what "usable" means:
//
//   1. India → macro is UNAVAILABLE (never borrow the US regime).
//   2. Age bound  → MAX_MACRO_AGE_DAYS (imported from scores.ts — single source
//                   of truth for the bound; see its justification there).
//   3. Indicator floor → >= MIN_MACRO_INDICATORS real indicators.
//   4. Fail-safe  → UNAVAILABLE, never calm/green.
//
// REUSE NOTE: `MAX_MACRO_AGE_DAYS` is imported rather than re-declared. The row
// SELECTION logic below is a second implementation only because scores.ts keeps
// `fetchMacroScore` (and its `MIN_MACRO_INDICATORS` / `macroRowAgeDays` helpers)
// module-private, and scores.ts is out of this change's ownership. Extracting a
// shared `lib/data/macro-regime.ts` that BOTH import is the right end state and
// is filed as a proposal — it requires editing scores.ts.

// Imports the age bound ONLY — no runtime import from ./allocator, so there is
// no import cycle between the two. This module reports the RAW regime label and
// leaves normalization to the allocator, which owns the Regime enum.
import { MAX_MACRO_AGE_DAYS } from "@/lib/data/scores";

export type MarketScope = "us" | "india";

// Mirrors MacroSentinel's OWN classification floor: computeRegime()
// (app/api/agents/macro-sentinel/route.ts) returns regime "unknown" when fewer
// than 3 of its 8 FRED indicators resolve, because "<3 indicators is NOT
// evidence of a healthy economy".
//
// This floor — not the age bound — is what rejects a FOSSIL: a failed run
// written out as a confident verdict. Prod holds `2026-06-30`:
// regime='green', danger_score=0, signals_triggered=0, raw_indicators=[]
// (ZERO indicators), summary "No recession signals. Economy in expansion."
// It predates the unknown-guard, so it is a failed run fossilized as calm. An
// age bound alone cannot catch a fossil that is FRESH; this can.
//
// `signals_triggered = 0` is explicitly NOT the discriminator: a genuinely calm
// week legitimately trips zero signals, and rejecting those would discard real
// `green` verdicts and bias the book bearish.
const MIN_MACRO_INDICATORS = 3;

function macroRowAgeDays(weekOf: unknown, now: Date): number {
  if (typeof weekOf !== "string") return Infinity; // unverifiable age → fail closed
  const t = Date.parse(`${weekOf}T00:00:00Z`);
  if (!Number.isFinite(t)) return Infinity;
  return (now.getTime() - t) / 86_400_000;
}

// `raw_indicators` is a jsonb ARRAY of indicator objects. A non-array
// (null/absent) means we cannot PROVE the run had evidence → fail closed (-1)
// rather than assume it did.
function macroIndicatorCount(rawIndicators: unknown): number {
  return Array.isArray(rawIndicators) ? rawIndicators.length : -1;
}

export type AllocationRegime =
  | { available: true; rawRegime: string; asOf: string; ageDays: number; indicators: number }
  | { available: false; reason: string; rejectedRows?: Record<string, unknown>[] };

/**
 * Load the macro regime that may drive allocation for `market`.
 *
 * India ALWAYS returns unavailable and never touches `macro_regime` — see the
 * note in loadAllocationRegime's india branch.
 */
export async function loadAllocationRegime(
  svc: any,
  market: MarketScope,
  now: Date = new Date(),
): Promise<AllocationRegime> {
  // India has NO macro regime — and must not borrow the US one.
  //
  // MacroSentinel is US-only BY CONSTRUCTION: all 8 indicators are US FRED
  // series (yield curve, Sahm rule, US GDP, nonfarm payrolls, US CPI, US retail
  // sales, fed funds, US durables). `macro_regime` carries NO `market` column,
  // so reading it for India stamps the US Fed's verdict onto Indian sleeve
  // weights — a per-market/per-currency violation on the money path (the equity
  // sleeve target tightens that market's gross-equity cap in paper sizing).
  //
  // We deliberately do NOT invent an India regime and do NOT wire
  // lib/india-macro.ts (NSE FII/DII flows) in here — that is a separate
  // approved build. This returns early WITHOUT querying the table at all, so
  // the US verdict cannot leak into an India code path even by accident.
  if (market === "india") {
    return {
      available: false,
      reason:
        "No India macro regime exists. MacroSentinel is US-only (8 US FRED series) and macro_regime has no market " +
        "column, so its verdict cannot drive Indian sleeve weights. Macro UNAVAILABLE for India.",
    };
  }

  try {
    // Order by `week_of` (the verdict's real as-of date), NOT `created_at` —
    // matching lib/data/scores.ts. `created_at` is write time and can invert
    // the true order: prod's `2026-06-29` row was WRITTEN on 06-30 04:44, after
    // the week it describes. Fetch 3 so a single `unknown` run can be covered
    // by the prior week's verdict — but only ever WITHIN the age bound below.
    const { data: rows } = await svc
      .from("macro_regime")
      .select("regime, week_of, raw_indicators")
      .order("week_of", { ascending: false })
      .limit(3);

    const allRows: any[] = Array.isArray(rows) ? rows : rows ? [rows] : [];
    if (!allRows.length) return { available: false, reason: "no macro_regime rows" };

    const rejected: Record<string, unknown>[] = [];
    for (const r of allRows) {
      if (!r) continue;
      const raw = String(r.regime ?? "").toLowerCase();
      const ageDays = macroRowAgeDays(r.week_of, now);
      const indicators = macroIndicatorCount(r.raw_indicators);

      let reason: string | null = null;
      if (raw === "unknown" || raw === "") reason = "no verdict (regime unknown)";
      else if (ageDays > MAX_MACRO_AGE_DAYS) reason = `stale: ${Math.floor(ageDays)}d old > ${MAX_MACRO_AGE_DAYS}d bound`;
      else if (indicators < MIN_MACRO_INDICATORS) {
        reason = `only ${indicators < 0 ? "unverifiable" : indicators} indicator(s) < ${MIN_MACRO_INDICATORS} — failed run, not a real verdict`;
      }
      if (reason) {
        rejected.push({ week_of: r.week_of, regime: r.regime, reason });
        continue;
      }
      return {
        available: true,
        rawRegime: String(r.regime),
        asOf: String(r.week_of),
        ageDays,
        indicators,
      };
    }

    // FAIL-SAFE: nothing recent and trustworthy → UNAVAILABLE. Never reach
    // further back, never fall back to green/calm/neutral.
    //
    // The summary names WHY EACH row was rejected rather than emitting a
    // generic "unavailable" — an operator reading this must be able to tell a
    // stale verdict from a zero-indicator fossil from a failed run without
    // digging into rejectedRows.
    const detail = rejected.map((r) => `${r.week_of} (${r.regime}): ${r.reason}`).join("; ");
    return {
      available: false,
      reason:
        `No usable macro verdict within the ${MAX_MACRO_AGE_DAYS}-day bound resting on >= ${MIN_MACRO_INDICATORS} ` +
        `indicators — macro UNAVAILABLE. Not defaulted to calm: an absent verdict is not a benign one. ` +
        `Rejected: ${detail || "no candidate rows"}.`,
      rejectedRows: rejected,
    };
  } catch {
    return { available: false, reason: "macro_regime query failed" };
  }
}
