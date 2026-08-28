// Alpha Diagnostic Lab — shared contract.
//
// READ-ONLY DIAGNOSTICS. Nothing in this feature may be imported by a scorer,
// PaperTrader, PositionMonitor, strategy promotion, proposal, order or broker
// path. Its strongest verdict is `owner_review`; it cannot promote anything.
//
// See features/alpha-diagnostic-lab/FEATURE_ARCHITECTURE.md.

import { MIN_EFFECTIVE_OBSERVATIONS, effectiveObservations } from "@/lib/learning/dimension-diagnostics";

export type DiagnosticMarket = "us" | "india";
export const ALPHA_DIAGNOSTIC_METRIC_VERSION = "alpha_diagnostics_v2_2";

/**
 * `descriptive_only` is NOT a weak pass. It means the number is reportable but
 * carries no pass/fail interpretation, which is the honest state for most of
 * this suite until the evidence floors are met.
 */
export type DiagnosticStatus =
  | "pass"
  | "fail"
  | "insufficient_evidence"
  | "data_invalid"
  | "descriptive_only";

export type DiagnosticVerdict =
  | "data_invalid"
  | "collect_more"
  | "reject_candidate"
  | "owner_review";

/** Accounting answers "what happened to the book"; learning answers "what may
 *  be used to compare policies". Neither may silently substitute for the other. */
export type DiagnosticCohort = "accounting" | "learning";

export interface DiagnosticSample {
  nRows: number;
  /** Independent decision dates. Raw row count is NEVER the sample size. */
  nDates: number;
  nSymbols: number;
  /** Horizon the metric was measured at, when the metric has one. */
  horizonDays?: number;
  /** Human-readable independence unit. Defaults to decision_date. */
  dateUnit?: "decision_date" | "entry_date" | "session" | "entry_vintage";
}

export interface DiagnosticFinding {
  market: DiagnosticMarket;
  testId: string;
  cohort: DiagnosticCohort;
  window: { from: string; to: string };
  sample: DiagnosticSample;
  /** Fraction of the attempted population the metric could actually be computed on. */
  coverage: number;
  metricVersion: string;
  status: DiagnosticStatus;
  reason: string;
  metrics: Record<string, unknown>;
}

/**
 * Owner-review floor. Deliberately far above the descriptive floor: a finding
 * may be SHOWN with fewer dates, but a candidate cannot be put in front of the
 * owner on them.
 */
export const MIN_REVIEW_DATES = 60;

/**
 * Decide a status from sample size alone, before any metric is interpreted.
 *
 * Applies BOTH floors, because they fail in different directions:
 *  - `minDates` catches a small sample outright;
 *  - the overlap correction catches a sample that looks large only because
 *    consecutive forward windows of `horizonDays` overlap almost entirely.
 * At h120, 20 dates is 0.17 independent observations. Counting dates alone
 * would call that a finding.
 */
export function sampleStatus(
  sample: DiagnosticSample,
  minDates: number,
): { ok: boolean; status: DiagnosticStatus; reason: string } {
  if (sample.nDates < minDates) {
    return {
      ok: false,
      status: "insufficient_evidence",
      reason: `${sample.nDates}/${minDates} independent decision dates; no interpretation permitted.`,
    };
  }
  if (sample.horizonDays != null) {
    const nEff = effectiveObservations(sample.nDates, sample.horizonDays);
    if (nEff < MIN_EFFECTIVE_OBSERVATIONS) {
      return {
        ok: false,
        status: "insufficient_evidence",
        reason: `${sample.nDates} dates at a ${sample.horizonDays}-day horizon overlap to ${nEff.toFixed(2)} independent observations (need ${MIN_EFFECTIVE_OBSERVATIONS}).`,
      };
    }
  }
  return { ok: true, status: "descriptive_only", reason: "Sample floors met; descriptive only until a paired comparison and the robustness gates run." };
}

/**
 * Canonical JSON: sorted keys, fixed numeric precision.
 *
 * Required by the re-run identity gate. `JSON.stringify` preserves insertion
 * order and emits shortest-roundtrip floats, so two runs computing identical
 * values can still produce different bytes — which would make the fingerprint
 * report a difference that does not exist.
 */
export function canonicalize(value: unknown, floatDigits = 10): string {
  const walk = (v: unknown): unknown => {
    if (v === null) return null;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return null; // NaN/Infinity are not JSON; never emit a bare token
      // -0 and 0 must serialize identically or the fingerprint splits on sign.
      const fixed = Number(v.toFixed(floatDigits));
      return Object.is(fixed, -0) ? 0 : fixed;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = walk(src[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/**
 * Deterministic, dependency-free digest over the canonical form.
 *
 * Two FNV-1a 32-bit passes with different offset bases, concatenated to 64 bits.
 * Deliberately NOT BigInt (tsconfig targets ES2017, where BigInt literals are
 * unavailable) and deliberately NOT node:crypto, so this module stays safe to
 * import from the client bundle alongside the UI. `Math.imul` gives the exact
 * 32-bit wraparound multiply the algorithm requires.
 *
 * Not a security hash. It only has to change when the content changes.
 */
function fnv1a32(text: string, offsetBasis: number): number {
  let h = offsetBasis;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 64 hex characters, because `backtest_experiments` constrains every
 * fingerprint column to `^[0-9a-f]{64}$` — the SHA-256 shape the rest of the
 * experiment registry uses. Eight FNV-1a passes with distinct offset bases,
 * each contributing 8 hex characters.
 *
 * This is a CHANGE-DETECTION digest, not a cryptographic hash: it satisfies the
 * registry's shape and reliably differs when content differs, but it has
 * nowhere near 256 bits of real entropy and must never be relied on to resist
 * a deliberate collision. SHA-256 via node:crypto was rejected so this module
 * stays safe to import from a client bundle.
 */
const FINGERPRINT_BASES = [
  0x811c9dc5, 0x9dc5811c, 0x1c9dc581, 0xc5811c9d,
  0x01000193, 0x93010001, 0x00019301, 0x19300100,
];

export function fingerprint(value: unknown): string {
  const text = canonicalize(value);
  return FINGERPRINT_BASES
    .map(base => fnv1a32(text, base).toString(16).padStart(8, "0"))
    .join("");
}

/** Content identity for unordered database result sets. Row counts and date
 * endpoints are insufficient: corrected values must produce a new run. */
export function fingerprintDataset(parts: Record<string, unknown[]>): string {
  const normalized: Record<string, unknown[]> = {};
  for (const key of Object.keys(parts).sort()) {
    normalized[key] = [...parts[key]].sort((a, b) => canonicalize(a).localeCompare(canonicalize(b)));
  }
  return fingerprint(normalized);
}

/**
 * The run's overall verdict.
 *
 * A0 is a hard gate: if data truth failed, every downstream number is
 * uninterpretable regardless of how good it looks, so the run cannot report
 * anything except `data_invalid`.
 */
export function resolveVerdict(findings: DiagnosticFinding[]): DiagnosticVerdict {
  if (findings.some(f => f.status === "data_invalid")) return "data_invalid";
  if (findings.some(f => f.testId === "A0" && f.status === "fail")) return "data_invalid";
  if (findings.some(f => f.status === "fail")) return "reject_candidate";
  // owner_review requires an actual passing paired comparison, not merely the
  // absence of failure -- AND not a passing A0.
  //
  // A0 is a data-truth GATE, not evidence about a candidate. Counting its pass
  // toward the verdict made a first production run report `owner_review` on a
  // book whose only passing test was "the ledger reconciles", which is the
  // absence-of-failure fallacy arriving through a different door. Only tests
  // that can establish a candidate may promote.
  const CANDIDATE_ESTABLISHING = new Set(["A2", "A6", "A8"]);
  const passing = findings.filter(f => f.status === "pass" && CANDIDATE_ESTABLISHING.has(f.testId));
  return passing.length > 0 ? "owner_review" : "collect_more";
}
