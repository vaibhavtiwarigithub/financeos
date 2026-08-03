// Yahoo custom screener — keyless US candidate discovery.
//
// Replaces the FinancialDatasets screener as the primary US discovery source.
// See features/us-keyless-screener/FEATURE_ARCHITECTURE.md.
//
// Two hard-won facts drive the shape of this module; both were measured, not
// assumed, and both are silent failures if got wrong:
//
//  1. THRESHOLDS ARE PERCENTAGES, NOT RATIOS. `returnonequity > 15` means 15%.
//     `totaldebtequity < 100` is the ratio 1.0. A ratio passed unconverted
//     matches everything and disables that leg without erroring.
//
//  2. A CRITERION CAN BE ACCEPTED AND SILENTLY DISCARDED.
//     `freecashflow.lasttwelvemonths` is in that state today: filtering on it at
//     one quadrillion dollars returns the same count as no filter at all. It is
//     therefore NOT in any bucket below, and `screenerFieldContract()` exists to
//     catch the next field that goes the same way.

import { getCrumb } from "@/lib/data/yahoo-crumb";

const SCREENER_URL = "https://query2.finance.yahoo.com/v1/finance/screener";
const UA = "Mozilla/5.0";

export type ScreenerOperand = [string, number | string];
export interface ScreenerClause {
  operator: "gt" | "lt" | "eq" | "or" | "and";
  operands: any[];
}

/**
 * Applied to every query and not overridable by callers.
 *
 * Without it, `region = us` admits OTC/pink-sheet foreign issues and preferred
 * share series. Measured: the momentum bucket's top results were GGPSF, NVPTF,
 * IDDTF, IDTVF, KXIAY, NLY-PF, NLY-PG. Those are not tradeable US common stock —
 * the broker cannot fill most of them, and a preferred series is not the security
 * the score describes.
 */
const BASE_CLAUSES: ScreenerClause[] = [
  { operator: "or", operands: [
    { operator: "eq", operands: ["exchange", "NMS"] },
    { operator: "eq", operands: ["exchange", "NYQ"] },
  ] },
  { operator: "gt", operands: ["dayvolume", 500_000] },
];

export interface ScreenerBucketSpec {
  id: "momentum" | "value";
  sortField: string;
  sortType: "ASC" | "DESC";
  clauses: ScreenerClause[];
}

// Thresholds carried over unchanged from the FinancialDatasets filters, converted
// to Yahoo's percent scale. This is a source swap, not a selectivity change.
export const US_BUCKETS: readonly ScreenerBucketSpec[] = [
  {
    id: "momentum",
    sortField: "quarterlyrevenuegrowth.quarterly",
    sortType: "DESC",
    clauses: [
      { operator: "gt", operands: ["quarterlyrevenuegrowth.quarterly", 15] },
      { operator: "gt", operands: ["epsgrowth.lasttwelvemonths", 10] },
      { operator: "gt", operands: ["grossprofitmargin.lasttwelvemonths", 25] },
      { operator: "gt", operands: ["returnonequity.lasttwelvemonths", 15] },
      { operator: "gt", operands: ["intradaymarketcap", 2_000_000_000] },
    ],
  },
  {
    id: "value",
    sortField: "peratio.lasttwelvemonths",
    sortType: "ASC",
    clauses: [
      { operator: "gt", operands: ["peratio.lasttwelvemonths", 0] },
      { operator: "lt", operands: ["peratio.lasttwelvemonths", 18] },
      { operator: "lt", operands: ["totaldebtequity.lasttwelvemonths", 100] },
      { operator: "gt", operands: ["intradaymarketcap", 1_000_000_000] },
      // No free-cash-flow leg: the criterion is silently ignored by the provider
      // and no working substitute exists. netincomemargin is honoured but is
      // earnings-derived, and cross-checking earnings against earnings is
      // circular — exactly the independence the FCF leg provided. Omitted
      // rather than approximated. See FEATURE_ARCHITECTURE.md §5.
    ],
  },
];

/**
 * Symbols the screener may return but research must not accept.
 * `-` marks a preferred/class series (NLY-PF), `.` marks units and warrants.
 */
export function isScreenableUsSymbol(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  if (!s || s.length > 5) return false;
  return /^[A-Z]+$/.test(s);
}

async function postScreener(body: unknown, timeoutMs = 12_000): Promise<any | null> {
  const c = await getCrumb();
  if (!c) return null;
  try {
    const res = await fetch(`${SCREENER_URL}?crumb=${encodeURIComponent(c.crumb)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        ...(c.cookie ? { Cookie: c.cookie } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.finance?.result?.[0] ?? null;
  } catch {
    return null;
  }
}

export function buildScreenerQuery(clauses: ScreenerClause[], size: number, sortField: string, sortType: "ASC" | "DESC") {
  return {
    size,
    offset: 0,
    sortField,
    sortType,
    quoteType: "EQUITY",
    query: { operator: "AND", operands: [...BASE_CLAUSES, ...clauses] },
    userId: "",
    userIdType: "guid",
  };
}

/** Ranked, validated symbols for one bucket. Empty on any failure — never throws. */
export async function screenUsBucket(spec: ScreenerBucketSpec, size = 12): Promise<string[]> {
  const result = await postScreener(buildScreenerQuery(spec.clauses, size, spec.sortField, spec.sortType));
  const quotes: any[] = result?.quotes ?? [];
  const out: string[] = [];
  for (const q of quotes) {
    const sym = String(q?.symbol ?? "").trim().toUpperCase();
    if (sym && isScreenableUsSymbol(sym) && !out.includes(sym)) out.push(sym);
  }
  return out;
}

// ── Field contract check ─────────────────────────────────────────────────────

export interface FieldContractResult {
  field: string;
  baseline: number | null;
  absurd: number | null;
  /** True only when a completed probe proved the criterion still filters. */
  honoured: boolean;
  /** False when the probe itself could not run — NOT evidence of health. */
  probed: boolean;
}

/** A threshold no security can satisfy, in the direction that empties the set. */
function absurdValue(operator: "gt" | "lt"): number {
  return operator === "gt" ? 999_999_999_999_999 : 0.0000001;
}

/**
 * Prove every criterion in the shipped buckets still filters.
 *
 * A criterion the provider accepts and discards produces no error, no exception
 * and no failing test — the screen keeps returning names and the bucket silently
 * widens to whatever the surviving legs allow. The only reliable detector is to
 * set a threshold nothing can satisfy and confirm the count collapses.
 *
 * Returns one row per numeric criterion.
 *
 * Three states, deliberately distinct — collapsing the last two into `honoured`
 * was the original defect: a Yahoo outage then looked exactly like a clean bill
 * of health, which is the same silent-failure shape this check exists to catch.
 *   probed && honoured    → proven to still filter
 *   probed && !honoured   → proven to be a no-op; the bucket is silently wider
 *   !probed               → UNKNOWN. Network or crumb failure. Not degradation,
 *                           and emphatically not health.
 */
export async function screenerFieldContract(): Promise<FieldContractResult[]> {
  const results: FieldContractResult[] = [];
  for (const spec of US_BUCKETS) {
    for (const clause of spec.clauses) {
      const [field] = clause.operands as ScreenerOperand;
      if (clause.operator !== "gt" && clause.operator !== "lt") continue;
      if (results.some(r => r.field === field)) continue;
      // Baseline: the same bucket minus this one criterion. Comparing against a
      // bare universe count would flag a criterion as broken merely because its
      // siblings already excluded everything.
      const others = spec.clauses.filter(c => c !== clause);
      const base = await postScreener(buildScreenerQuery(others, 1, spec.sortField, spec.sortType));
      const withAbsurd = await postScreener(buildScreenerQuery(
        [...others, { operator: clause.operator, operands: [field, absurdValue(clause.operator)] }],
        1, spec.sortField, spec.sortType,
      ));
      const baseline = typeof base?.total === "number" ? base.total : null;
      const absurd = typeof withAbsurd?.total === "number" ? withAbsurd.total : null;
      const probed = baseline !== null && absurd !== null;
      results.push({
        field: String(field),
        baseline,
        absurd,
        // Only a completed probe can assert anything. An unreachable provider
        // yields probed:false and is reported separately, never as honoured.
        honoured: probed ? absurd! < baseline! : false,
        probed,
      });
    }
  }
  return results;
}
