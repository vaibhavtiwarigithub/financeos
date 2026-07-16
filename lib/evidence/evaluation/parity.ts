// Frozen dual-run evaluation — semantic parity comparator (router-cutover §4).
//
// "Same or better coverage" is NOT parity. This comparator decides whether a
// candidate (Router) observation of a canonical field means the SAME THING as
// the legacy observation of that field, from the same knowledge cutoff.
//
// Rules, per §4 "Semantic parity" — implemented literally:
//   - exact match for enums, dates, currency, basis, period, and nullability;
//   - documented numeric tolerance ONLY after unit/period normalization;
//   - NO tolerance across TTM/quarterly/annual/forward or adjusted/unadjusted;
//   - field-level provenance and conflict state retained; and
//   - unexplained disagreement FAILS the candidate even when the aggregate
//     score is close.
//
// Pure + deterministic: no DB, no network, no LLM, no clock.

import type { Currency, FieldUnit, MetricBasis } from "@/lib/evidence/contracts";
import type { ScorerFieldContract } from "@/lib/evidence/intent-classification";

// ── bounded divergence codes ─────────────────────────────────────────────────

export type DivergenceCode =
  // agreeing
  | "identical"
  | "value_within_tolerance"
  | "both_unavailable"
  // hard semantic failures — never tolerable, never "close enough"
  | "basis_mismatch"
  | "period_mismatch"
  | "currency_mismatch"
  | "unit_mismatch"
  | "nullability_mismatch"
  | "adjustment_mismatch"
  | "provenance_missing"
  | "schema_invalid"
  // measurable differences requiring classification + owner review
  | "value_outside_tolerance"
  | "availability_gain"
  | "availability_loss"
  | "quality_degraded"
  | "quality_improved";

/** Codes that fail the candidate outright when unexplained. */
const HARD_FAIL: ReadonlySet<DivergenceCode> = new Set<DivergenceCode>([
  "basis_mismatch",
  "period_mismatch",
  "currency_mismatch",
  "unit_mismatch",
  "nullability_mismatch",
  "adjustment_mismatch",
  "provenance_missing",
  "schema_invalid",
]);

export function isHardFail(code: DivergenceCode): boolean {
  return HARD_FAIL.has(code);
}

const AGREEING: ReadonlySet<DivergenceCode> = new Set<DivergenceCode>([
  "identical",
  "value_within_tolerance",
  "both_unavailable",
]);

export function isAgreement(code: DivergenceCode): boolean {
  return AGREEING.has(code);
}

// ── basis families: what may NEVER be compared under tolerance ───────────────

// Two bases in DIFFERENT families describe different facts. §4 forbids any
// numeric tolerance across TTM/quarterly/annual/forward — so each is its own
// family and any cross-family pair is a `basis_mismatch`, full stop. Even
// identical numbers under different bases are a mismatch: agreeing by luck is
// not agreeing by contract.
const BASIS_FAMILY: Record<MetricBasis, string> = {
  ttm: "ttm",
  quarterly: "quarterly",
  annual: "annual",
  forward: "forward",
  spot: "spot",
  eod: "eod",
};

export function basesComparable(a: MetricBasis, b: MetricBasis): boolean {
  return BASIS_FAMILY[a] === BASIS_FAMILY[b];
}

// ── the observation under comparison ─────────────────────────────────────────

/** One canonical field observation from one path (legacy or candidate). */
export interface FieldObservationForParity {
  /** null = the path produced no value (unavailable/abstain/failure). */
  value: number | string | boolean | null;
  present: boolean;
  quality: string;
  basis: MetricBasis | null;
  /** Fiscal period the value describes (ISO date). Compared EXACTLY. */
  periodEnd: string | null;
  currency: Currency | null;
  unit: FieldUnit | null;
  /** Price-series adjustment flag. Compared EXACTLY — never tolerated. */
  adjusted?: boolean | null;
  providerId: string | null;
  /** True when the path reported providers disagreeing on this field. */
  conflict?: boolean;
}

export interface FieldComparatorSpec {
  fieldId: string;
  /**
   * Relative tolerance applied ONLY after unit/period/basis have been proven
   * identical. 0 = exact. Enums/dates/strings ignore this entirely.
   */
  relativeTolerance: number;
  /** Absolute floor so near-zero denominators don't inflate relative error. */
  absoluteTolerance: number;
  /** Treat the value as an enum/date/string: exact match only, no tolerance. */
  exactOnly: boolean;
}

/**
 * Default comparators. Deliberately tight: a tolerance is a documented decision,
 * not a default. Anything not listed compares exactly.
 */
export const DEFAULT_COMPARATORS: Record<string, FieldComparatorSpec> = {
  "technical.daily_bars": { fieldId: "technical.daily_bars", relativeTolerance: 0, absoluteTolerance: 0, exactOnly: false },
  "fundamental.reported_core": { fieldId: "fundamental.reported_core", relativeTolerance: 0.005, absoluteTolerance: 1e-6, exactOnly: false },
  "fundamental.valuation": { fieldId: "fundamental.valuation", relativeTolerance: 0.005, absoluteTolerance: 1e-6, exactOnly: false },
  "sentiment.news_tone": { fieldId: "sentiment.news_tone", relativeTolerance: 0.01, absoluteTolerance: 1e-6, exactOnly: false },
  "insider.net_flow": { fieldId: "insider.net_flow", relativeTolerance: 0.01, absoluteTolerance: 1e-6, exactOnly: false },
  "macro.regime": { fieldId: "macro.regime", relativeTolerance: 0, absoluteTolerance: 0, exactOnly: true },
  "analyst.consensus_narrative": { fieldId: "analyst.consensus_narrative", relativeTolerance: 0, absoluteTolerance: 0, exactOnly: true },
};

export function comparatorFor(fieldId: string): FieldComparatorSpec {
  return (
    DEFAULT_COMPARATORS[fieldId] ?? {
      fieldId,
      relativeTolerance: 0,
      absoluteTolerance: 0,
      exactOnly: true,
    }
  );
}

export interface FieldComparison {
  fieldId: string;
  code: DivergenceCode;
  /** A parity verdict — agreement or a classified, non-fatal difference. */
  agrees: boolean;
  hardFail: boolean;
  detail: string;
  legacy: FieldObservationForParity;
  candidate: FieldObservationForParity;
  /** Relative difference when both are numeric and comparable; else null. */
  relativeDelta: number | null;
}

function numeric(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Compare one canonical field across the two paths.
 *
 * Order matters: the semantic axes (nullability, basis, period, currency, unit,
 * adjustment) are checked BEFORE any value comparison, so a numeric tolerance
 * can never be reached while the two values describe different facts.
 */
export function compareField(
  legacy: FieldObservationForParity,
  candidate: FieldObservationForParity,
  contract: ScorerFieldContract | undefined,
  spec: FieldComparatorSpec,
): FieldComparison {
  const mk = (code: DivergenceCode, detail: string, relativeDelta: number | null = null): FieldComparison => ({
    fieldId: spec.fieldId,
    code,
    agrees: isAgreement(code),
    hardFail: isHardFail(code),
    detail,
    legacy,
    candidate,
    relativeDelta,
  });

  // 1. availability / nullability — an exact-match axis (§4).
  if (!legacy.present && !candidate.present) {
    return mk("both_unavailable", "neither path produced a value — includes abstain/failure rows, which the cohort must retain");
  }
  if (!legacy.present && candidate.present) {
    // NOT automatically good. Added coverage is measured, never silently
    // treated as approval to trade more names (§5).
    return mk("availability_gain", `candidate produced a value (${candidate.providerId ?? "?"}) where legacy had none — must be classified before it may create eligibility`);
  }
  if (legacy.present && !candidate.present) {
    return mk("availability_loss", `candidate lost a value legacy had (${legacy.providerId ?? "?"}) — coverage regression`);
  }
  if (legacy.value === null || candidate.value === null) {
    // present-but-null on exactly one side is a nullability disagreement.
    if ((legacy.value === null) !== (candidate.value === null)) {
      return mk("nullability_mismatch", `present-but-null on one side only (legacy=${String(legacy.value)}, candidate=${String(candidate.value)})`);
    }
    return mk("identical", "both present and explicitly null");
  }

  // 2. provenance must exist on both sides — an untraceable value cannot be
  //    proven equivalent, so it fails rather than passing quietly.
  if (!candidate.providerId || !legacy.providerId) {
    return mk("provenance_missing", `field-level provenance absent (legacy=${legacy.providerId ?? "none"}, candidate=${candidate.providerId ?? "none"})`);
  }

  // 3. basis — NO tolerance across TTM/quarterly/annual/forward (§4).
  if (legacy.basis !== candidate.basis) {
    if (!legacy.basis || !candidate.basis || !basesComparable(legacy.basis, candidate.basis)) {
      return mk("basis_mismatch", `basis ${legacy.basis ?? "none"} vs ${candidate.basis ?? "none"} — different facts; no tolerance applies even if the numbers agree`);
    }
  }
  if (contract && candidate.basis && !contract.allowedBases.includes(candidate.basis)) {
    return mk("basis_mismatch", `candidate basis ${candidate.basis} is outside the field contract's allowed bases [${contract.allowedBases.join(",")}]`);
  }

  // 4. period — exact date match.
  if ((legacy.periodEnd ?? null) !== (candidate.periodEnd ?? null)) {
    return mk("period_mismatch", `periodEnd ${legacy.periodEnd ?? "none"} vs ${candidate.periodEnd ?? "none"} — a different fiscal period is a different fact`);
  }

  // 5. currency — exact. A cross-currency swap is a market failure, not a delta.
  if ((legacy.currency ?? null) !== (candidate.currency ?? null)) {
    return mk("currency_mismatch", `currency ${legacy.currency ?? "none"} vs ${candidate.currency ?? "none"}`);
  }

  // 6. unit — exact. Tolerance is only meaningful after units match.
  if ((legacy.unit ?? null) !== (candidate.unit ?? null)) {
    return mk("unit_mismatch", `unit ${legacy.unit ?? "none"} vs ${candidate.unit ?? "none"} — normalize before any tolerance may be applied`);
  }

  // 7. adjusted/unadjusted — exact, no tolerance (§4).
  const la = legacy.adjusted ?? null;
  const ca = candidate.adjusted ?? null;
  if (la !== ca) {
    return mk("adjustment_mismatch", `adjusted=${String(la)} vs ${String(ca)} — adjusted and unadjusted series are not comparable under tolerance`);
  }

  // 8. conflict state is retained, not averaged away.
  if (candidate.conflict && !legacy.conflict) {
    return mk("quality_degraded", "candidate reports provider conflict where legacy did not — conflict is retained, never resolved into a neutral value");
  }

  // 9. only now may values be compared.
  if (typeof legacy.value !== typeof candidate.value) {
    return mk("schema_invalid", `type ${typeof legacy.value} vs ${typeof candidate.value}`);
  }
  if (spec.exactOnly || !numeric(legacy.value) || !numeric(candidate.value)) {
    return legacy.value === candidate.value
      ? mk("identical", "exact match")
      : mk("value_outside_tolerance", `enum/date/string mismatch: ${String(legacy.value)} vs ${String(candidate.value)} — exact-match field, no tolerance`);
  }

  const l = legacy.value;
  const c = candidate.value;
  if (l === c) return mk("identical", "exact numeric match", 0);

  const denom = Math.max(Math.abs(l), Math.abs(c));
  const absDelta = Math.abs(l - c);
  const relDelta = denom > 0 ? absDelta / denom : 0;
  const withinAbs = absDelta <= spec.absoluteTolerance;
  const withinRel = spec.relativeTolerance > 0 && relDelta <= spec.relativeTolerance;

  if (withinAbs || withinRel) {
    return mk("value_within_tolerance", `Δ=${absDelta.toExponential(3)} (rel ${(relDelta * 100).toFixed(4)}%) within documented tolerance after unit/period/basis normalization`, relDelta);
  }
  // Quality changes are reported alongside, but a value gap outside tolerance is
  // the finding — the aggregate score being close is irrelevant (§4).
  return mk("value_outside_tolerance", `legacy=${l} vs candidate=${c} (rel ${(relDelta * 100).toFixed(4)}% > ${(spec.relativeTolerance * 100).toFixed(4)}%)`, relDelta);
}

export interface SymbolParity {
  symbol: string;
  comparisons: FieldComparison[];
  hardFails: FieldComparison[];
  disagreements: FieldComparison[];
  /** Parity holds when no hard fail and no unexplained value disagreement. */
  parity: boolean;
}

export function compareSymbol(
  symbol: string,
  legacy: Record<string, FieldObservationForParity>,
  candidate: Record<string, FieldObservationForParity>,
  contracts: Map<string, ScorerFieldContract>,
): SymbolParity {
  const fieldIds = [...new Set([...Object.keys(legacy), ...Object.keys(candidate)])].sort();
  const comparisons = fieldIds.map((fieldId) => {
    const empty: FieldObservationForParity = {
      value: null, present: false, quality: "unavailable", basis: null,
      periodEnd: null, currency: null, unit: null, providerId: null,
    };
    return compareField(
      legacy[fieldId] ?? empty,
      candidate[fieldId] ?? empty,
      contracts.get(fieldId),
      comparatorFor(fieldId),
    );
  });
  const hardFails = comparisons.filter((c) => c.hardFail);
  const disagreements = comparisons.filter((c) => !c.agrees);
  return { symbol, comparisons, hardFails, disagreements, parity: disagreements.length === 0 };
}
