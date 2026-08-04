// Frozen dual-run evaluation — cohort scorer + activation gate (§4, §5).
//
// One IMMUTABLE evaluation cohort per market. Everything that could move a
// result is frozen into the cohort object: universe, as-of, baseline policy,
// candidate policy, strategy/genome, threshold, ranks, and price basis. Both
// paths are then scored with the SAME production scorer
// (lib/scoring/weighted-score.ts) and the SAME production direction gate
// (lib/signal-direction.ts) — never a parallel re-implementation, which is how
// an evaluation quietly stops predicting the thing it claims to predict.
//
// Two properties the design turns on:
//
//  1. THE COHORT IS WHOLE. Symbols where either path abstains or fails are
//     first-class rows. Comparing only jointly-successful rows is exactly how
//     an availability-driven eligibility flip hides (§4).
//  2. RANKS ARE COHORT-LEVEL. One symbol's missing dimension displaces every
//     other symbol's rank. A per-symbol recomputation cannot see that, so
//     ranking is computed across the frozen cohort in both paths.
//
// Pure + deterministic: no DB, no network, no LLM, no clock. Persistence and
// the activation RPC call live elsewhere; this module only decides.

import {
  computeWeightedAnalystScore,
  isThinEvidence,
  SCORE_DIMENSIONS,
  type DimensionRecord,
  type ScoreDimension,
} from "@/lib/scoring/weighted-score";
import { capEtfLikeScore } from "@/lib/scoring/archetypes";
import { resolveSignalDirection } from "@/lib/signal-direction";
import type { Market } from "@/lib/evidence/contracts";
import type { SymbolShape } from "@/lib/evidence/intent-classification";
import { contractsFor } from "@/lib/evidence/intent-classification";
import {
  compareSymbol,
  type FieldObservationForParity,
  type SymbolParity,
} from "@/lib/evidence/evaluation/parity";

export const EVALUATION_CODE_VERSION = "evidence-evaluation-v2";

// ── frozen inputs ────────────────────────────────────────────────────────────

export type PathStatus = "scored" | "abstained" | "failed";

/** One path's (legacy or candidate) view of one symbol, from the frozen snapshot. */
export interface PathObservation {
  status: PathStatus;
  /** Per-dimension scores. Ignored for dimensions excluded by `included`. */
  scores: DimensionRecord<number>;
  /** The availability mask that actually drove the weighting. */
  included: DimensionRecord<boolean>;
  /** Canonical field observations for the parity comparator. */
  fields: Record<string, FieldObservationForParity>;
  /** Why this path produced nothing, when status != "scored". */
  failureReason?: string;
  /** True when this path served the symbol from a policy-allowed stale value. */
  staleFallback?: boolean;
  /** True when this path resolved a provider conflict to produce its value. */
  conflictResolved?: boolean;
}

export interface CohortRow {
  symbol: string;
  shape: SymbolShape;
  isHeld: boolean;
  legacy: PathObservation;
  candidate: PathObservation;
}

/**
 * The frozen cohort. Every field here is part of the evaluation's identity: an
 * activation is bound to this exact object's fingerprint, so changing any of it
 * invalidates the approval rather than silently re-scoping it.
 */
export interface FrozenCohort {
  evaluationId: string;
  market: Market;
  /** Knowledge cutoff — BOTH paths are constructed from this same as-of. */
  asOf: string;
  /** Validated completed market session represented by the decisions (YYYY-MM-DD). */
  marketSessionDate: string;
  universeSnapshotId: string;
  baselinePolicyVersionId: string;
  candidatePolicyVersionId: string;
  strategyVersion: string;
  /** Frozen genome/strategy weights — identical for both paths by construction. */
  weights: DimensionRecord<number>;
  /** Frozen entry threshold. */
  scoreThreshold: number;
  /** Frozen price basis, e.g. "eod_adjusted". A basis change is not a delta. */
  priceBasis: string;
  rows: CohortRow[];
  evaluationCodeVersion: string;
  /** Pre-approved coverage non-inferiority margin (§5), as a fraction. */
  coverageNonInferiorityMargin: number;
  /** Ranks are adverse below this displacement; only enforced when missingness-caused. */
  maxAdverseRankDisplacement: number;
  /** Maximum absolute aggregate score drift allowed for unattended parity. */
  maxScoreDelta?: number;
}

// ── scored output ────────────────────────────────────────────────────────────

export interface ScoredSymbol {
  symbol: string;
  status: PathStatus;
  score: number | null;
  includedDims: ScoreDimension[];
  renormalized: boolean;
  thinEvidence: boolean;
  direction: "long" | "neutral" | "short";
  eligible: boolean;
  /** 1-based rank among ELIGIBLE symbols by score desc; null when not eligible. */
  rank: number | null;
}

/**
 * Score one path across the WHOLE frozen cohort, then rank.
 *
 * `eligible` means "this path would open a NEW long here" — held positions are
 * excluded from eligibility because their direction is an exit decision, not an
 * entry. That keeps the flip gate focused on the thing it protects: a provider
 * change must never create a new long.
 */
export function scorePath(cohort: FrozenCohort, path: "legacy" | "candidate"): ScoredSymbol[] {
  const scored: ScoredSymbol[] = cohort.rows.map((row) => {
    const obs = row[path];
    if (obs.status !== "scored") {
      return {
        symbol: row.symbol,
        status: obs.status,
        score: null,
        includedDims: [],
        renormalized: false,
        thinEvidence: true,
        // A failed/abstained path never produces an entry. It must still appear
        // in the cohort — that is the point of §4's "include abstains".
        direction: "neutral" as const,
        eligible: false,
        rank: null,
      };
    }
    // The EXACT production scorer + direction gate.
    //
    // "Exact" has to include the ETF cap. Production applies it in
    // research-agent.ts after the weighted score; omitting it here made every
    // ETF and metal fund score higher in BOTH legs than production recorded,
    // which failed the legacy-reproduction proof and silently mis-stated the
    // candidate leg's score_delta for the same symbols.
    const weighted = computeWeightedAnalystScore(obs.scores, obs.included, cohort.weights);
    const { renormalized, includedDims } = weighted;
    const score = capEtfLikeScore(weighted.score, row.shape === "etf" || row.shape === "metal");
    const thin = isThinEvidence(includedDims);
    const gate = resolveSignalDirection({
      isHeld: row.isHeld,
      analystScore: score,
      scoreThreshold: cohort.scoreThreshold,
      thinEvidence: thin,
      includedDimsCount: includedDims.length,
      // Narrative never sets direction; the evaluation must not model it either.
      llmDirection: undefined,
    });
    return {
      symbol: row.symbol,
      status: obs.status,
      score,
      includedDims,
      renormalized,
      thinEvidence: thin,
      direction: gate.direction,
      eligible: gate.direction === "long" && !row.isHeld,
      rank: null,
    };
  });

  // Cohort-level ranking among eligible names. Ties break on symbol so the
  // evaluation is byte-reproducible.
  const ranked = scored
    .filter((s) => s.eligible)
    .sort((a, b) => (b.score! - a.score!) || a.symbol.localeCompare(b.symbol));
  ranked.forEach((s, i) => { s.rank = i + 1; });
  return scored;
}

// ── flip classification (bounded codes) ──────────────────────────────────────

export type FlipCause =
  | "none"
  | "genuine_value_change"      // same contract, real fact moved — reviewable
  | "source_availability"       // candidate simply has data legacy lacked
  | "stale_fallback"            // candidate served a stale value
  | "field_omission"            // candidate dropped a field, renormalizing around it
  | "conflict_resolution"       // candidate resolved a provider disagreement
  | "basis_mapping"             // a basis/period/unit/currency mapping difference
  | "weight_renormalization"    // eligibility appeared only because weights redistributed
  | "unexplained";              // cannot be attributed — always fails the candidate

export type FlipDirection = "none" | "ineligible_to_eligible" | "eligible_to_ineligible";

export interface SymbolDelta {
  symbol: string;
  legacy: ScoredSymbol;
  candidate: ScoredSymbol;
  parity: SymbolParity;
  scoreDelta: number | null;
  rankDelta: number | null;
  flip: FlipDirection;
  cause: FlipCause;
  /** True when the flip is attributable to something other than a real fact. */
  blocking: boolean;
  note: string;
}

/**
 * Classify WHY eligibility changed. §5 forbids a new eligibility created only by
 * availability, stale fallback, field omission, conflict resolution, basis
 * mapping, or weight renormalization — those are artifacts of routing, not
 * facts about the company. Only a genuine same-contract value change may create
 * eligibility, and even then only with explicit owner approval.
 *
 * Ordering is deliberate: the artifact causes are tested BEFORE
 * `genuine_value_change`, so a flip that has ANY routing explanation is never
 * mislabelled as a real fact.
 */
function classifyFlip(row: CohortRow, legacy: ScoredSymbol, candidate: ScoredSymbol, parity: SymbolParity): { cause: FlipCause; note: string } {
  const gained = parity.comparisons.filter((c) => c.code === "availability_gain");
  const lost = parity.comparisons.filter((c) => c.code === "availability_loss");
  const basisish = parity.comparisons.filter((c) =>
    c.code === "basis_mismatch" || c.code === "period_mismatch" ||
    c.code === "unit_mismatch" || c.code === "currency_mismatch" ||
    c.code === "adjustment_mismatch");
  const valueMoved = parity.comparisons.filter((c) => c.code === "value_outside_tolerance");

  if (basisish.length > 0) {
    return { cause: "basis_mapping", note: `basis/period/unit/currency mapping differs on: ${basisish.map((c) => c.fieldId).join(", ")}` };
  }
  if (row.candidate.staleFallback) {
    return { cause: "stale_fallback", note: "candidate served a policy-allowed stale observation" };
  }
  if (row.candidate.conflictResolved) {
    return { cause: "conflict_resolution", note: "candidate resolved a provider disagreement to produce its value" };
  }
  if (gained.length > 0) {
    return { cause: "source_availability", note: `candidate gained coverage on: ${gained.map((c) => c.fieldId).join(", ")} — measured, not approved` };
  }
  if (lost.length > 0) {
    return { cause: "field_omission", note: `candidate lost: ${lost.map((c) => c.fieldId).join(", ")} and renormalized around the gap` };
  }
  // No field-level explanation, but the weighting changed shape → the flip came
  // from redistributing weight, not from new information.
  if (candidate.renormalized !== legacy.renormalized ||
      candidate.includedDims.length !== legacy.includedDims.length) {
    return { cause: "weight_renormalization", note: `included dims ${legacy.includedDims.length}→${candidate.includedDims.length}, renormalized ${legacy.renormalized}→${candidate.renormalized}` };
  }
  if (valueMoved.length > 0) {
    // Same contract on every axis (basis/period/unit/currency/adjustment all
    // matched above) and the same fields present — the fact itself moved.
    return { cause: "genuine_value_change", note: `same-contract value change on: ${valueMoved.map((c) => `${c.fieldId} (rel ${((c.relativeDelta ?? 0) * 100).toFixed(3)}%)`).join(", ")} — requires owner review` };
  }
  return { cause: "unexplained", note: "eligibility changed with no field-level explanation — fails the candidate" };
}

// ── gate verdict (§5) ────────────────────────────────────────────────────────

export type GateFailureCode =
  | "unexplained_flip"
  | "artifact_created_eligibility"
  | "adverse_rank_displacement_from_missingness"
  | "coverage_below_non_inferiority_margin"
  | "optional_coverage_below_quality_margin"
  | "score_drift_exceeds_quality_limit"
  | "hard_semantic_failure"
  | "ledger_proof_missing"
  | "legacy_reproduction_failed";

export interface CoverageStat {
  fieldId: string;
  /** Symbols for which the field is structurally applicable — the denominator. */
  applicable: number;
  legacyCovered: number;
  candidateCovered: number;
  legacyRate: number;
  candidateRate: number;
  delta: number;
}

export interface GateFailure {
  code: GateFailureCode;
  symbol: string | null;
  detail: string;
}

export interface CohortEvaluation {
  evaluationId: string;
  market: Market;
  evaluationCodeVersion: string;
  candidatePolicyVersionId: string;
  baselinePolicyVersionId: string;
  strategyVersion: string;
  asOf: string;
  cohortFingerprint: string;
  deltas: SymbolDelta[];
  coverage: CoverageStat[];
  counts: {
    symbols: number;
    legacyScored: number;
    candidateScored: number;
    legacyAbstainedOrFailed: number;
    candidateAbstainedOrFailed: number;
    newlyEligible: number;
    newlyIneligible: number;
    hardSemanticFailures: number;
  };
  failures: GateFailure[];
  safetyFailures: GateFailure[];
  qualityFailures: GateFailure[];
  safetyPass: boolean;
  qualityPass: boolean;
  /** Did every deterministic machine gate pass? Human review is separate. */
  passed: boolean;
  /** Genuine changes needing explicit owner sign-off before activation. */
  requiresOwnerReview: SymbolDelta[];
}

/** Stable, order-independent fingerprint of the frozen cohort's identity. */
export function cohortFingerprint(cohort: FrozenCohort): string {
  const identity = {
    market: cohort.market,
    asOf: cohort.asOf,
    marketSessionDate: cohort.marketSessionDate,
    universeSnapshotId: cohort.universeSnapshotId,
    baseline: cohort.baselinePolicyVersionId,
    candidate: cohort.candidatePolicyVersionId,
    strategyVersion: cohort.strategyVersion,
    weights: SCORE_DIMENSIONS.map((d) => `${d}=${cohort.weights[d]}`).join(","),
    threshold: cohort.scoreThreshold,
    priceBasis: cohort.priceBasis,
    codeVersion: cohort.evaluationCodeVersion,
    maxScoreDelta: cohort.maxScoreDelta ?? 2,
    symbols: cohort.rows.map((r) => r.symbol).slice().sort().join(","),
  };
  // djb2 — deterministic and dependency-free; this is an identity tag, not a
  // security primitive (the DB stores the full frozen inputs alongside it).
  const s = JSON.stringify(identity);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `cohort-${h.toString(16).padStart(8, "0")}-${cohort.rows.length}`;
}

/** Causes that may NEVER create a new eligibility (§5, bullet 2). */
const ARTIFACT_CAUSES: ReadonlySet<FlipCause> = new Set<FlipCause>([
  "source_availability",
  "stale_fallback",
  "field_omission",
  "conflict_resolution",
  "basis_mapping",
  "weight_renormalization",
]);

function coverageStats(cohort: FrozenCohort): CoverageStat[] {
  const fieldIds = new Set<string>();
  for (const row of cohort.rows) {
    for (const c of contractsFor(cohort.market, row.shape)) fieldIds.add(c.fieldId);
  }
  return [...fieldIds].sort().map((fieldId) => {
    let applicable = 0, legacyCovered = 0, candidateCovered = 0;
    for (const row of cohort.rows) {
      // Denominator = structurally applicable symbols only. Counting an ETF's
      // absent fundamentals as a coverage miss would make every cohort look
      // starved and hide real regressions.
      const applies = contractsFor(cohort.market, row.shape).some((c) => c.fieldId === fieldId);
      if (!applies) continue;
      applicable += 1;
      if (row.legacy.fields[fieldId]?.present) legacyCovered += 1;
      if (row.candidate.fields[fieldId]?.present) candidateCovered += 1;
    }
    const legacyRate = applicable > 0 ? legacyCovered / applicable : 0;
    const candidateRate = applicable > 0 ? candidateCovered / applicable : 0;
    return { fieldId, applicable, legacyCovered, candidateCovered, legacyRate, candidateRate, delta: candidateRate - legacyRate };
  });
}

/**
 * Run the frozen dual-run evaluation and produce the activation verdict.
 *
 * Deterministic and side-effect free — the same cohort always yields the same
 * verdict, which is what makes an approval bindable to an evaluation ID.
 */
export function evaluateCohort(cohort: FrozenCohort): CohortEvaluation {
  const legacyScored = scorePath(cohort, "legacy");
  const candidateScored = scorePath(cohort, "candidate");
  const legacyBySymbol = new Map(legacyScored.map((s) => [s.symbol, s]));
  const candidateBySymbol = new Map(candidateScored.map((s) => [s.symbol, s]));

  const safetyFailures: GateFailure[] = [];
  const qualityFailures: GateFailure[] = [];
  const deltas: SymbolDelta[] = [];
  const requiresOwnerReview: SymbolDelta[] = [];

  for (const row of cohort.rows) {
    const l = legacyBySymbol.get(row.symbol)!;
    const c = candidateBySymbol.get(row.symbol)!;
    const contracts = new Map(contractsFor(cohort.market, row.shape).map((x) => [x.fieldId, x]));
    const parity = compareSymbol(row.symbol, row.legacy.fields, row.candidate.fields, contracts);

    const flip: FlipDirection =
      !l.eligible && c.eligible ? "ineligible_to_eligible" :
      l.eligible && !c.eligible ? "eligible_to_ineligible" : "none";

    let cause: FlipCause = "none";
    let note = "";
    if (flip !== "none") {
      const cls = classifyFlip(row, l, c, parity);
      cause = cls.cause;
      note = cls.note;
    } else if (parity.disagreements.length > 0) {
      note = `no flip; ${parity.disagreements.length} field divergence(s): ${parity.disagreements.map((d) => `${d.fieldId}=${d.code}`).join(", ")}`;
    }

    // A hard semantic failure fails the candidate regardless of flips or how
    // close the aggregate score is (§4 closing rule).
    for (const hf of parity.hardFails) {
      safetyFailures.push({ code: "hard_semantic_failure", symbol: row.symbol, detail: `${hf.fieldId}: ${hf.code} — ${hf.detail}` });
    }

    let blocking = false;
    if (flip === "ineligible_to_eligible") {
      if (cause === "unexplained") {
        blocking = true;
        safetyFailures.push({ code: "unexplained_flip", symbol: row.symbol, detail: note });
      } else if (ARTIFACT_CAUSES.has(cause)) {
        blocking = true;
        safetyFailures.push({
          code: "artifact_created_eligibility",
          symbol: row.symbol,
          detail: `new long created by "${cause}", not by a fact: ${note}`,
        });
      }
      // genuine_value_change is NOT auto-blocking — but it cannot self-approve.
    }

    // Rank displacement attributable ONLY to missingness. A rank that moved
    // because a real value moved is a legitimate re-ordering; a rank that moved
    // because the candidate lost a field is the candidate degrading the cohort.
    const rankDelta = l.rank !== null && c.rank !== null ? c.rank - l.rank : null;
    if (
      rankDelta !== null &&
      rankDelta >= cohort.maxAdverseRankDisplacement &&
      (cause === "field_omission" || parity.comparisons.some((x) => x.code === "availability_loss"))
    ) {
      qualityFailures.push({
        code: "adverse_rank_displacement_from_missingness",
        symbol: row.symbol,
        detail: `rank ${l.rank} → ${c.rank} (+${rankDelta}) attributable to lost fields, not to a value change`,
      });
      blocking = true;
    }

    const delta: SymbolDelta = {
      symbol: row.symbol,
      legacy: l,
      candidate: c,
      parity,
      scoreDelta: l.score !== null && c.score !== null ? c.score - l.score : null,
      rankDelta,
      flip,
      cause,
      blocking,
      note,
    };
    deltas.push(delta);

    if (delta.scoreDelta !== null && Math.abs(delta.scoreDelta) > (cohort.maxScoreDelta ?? 2)) {
      qualityFailures.push({
        code: "score_drift_exceeds_quality_limit",
        symbol: row.symbol,
        detail: `aggregate score drift ${delta.scoreDelta > 0 ? "+" : ""}${delta.scoreDelta} exceeds ±${cohort.maxScoreDelta ?? 2}`,
      });
    }

    if (flip === "ineligible_to_eligible" && cause === "genuine_value_change") {
      requiresOwnerReview.push(delta);
    }
  }

  // Required-field losses are safety failures. Optional score-affecting losses
  // remain entry-safe but fail the independent product-quality verdict.
  const coverage = coverageStats(cohort);
  for (const stat of coverage) {
    const matchingContracts = cohort.rows.flatMap((row) =>
      contractsFor(cohort.market, row.shape).filter((c) => c.fieldId === stat.fieldId));
    const isRequired = matchingContracts.some((c) => c.required);
    const isScoreAffecting = matchingContracts.some((c) => c.requiredClass === "score_affecting");
    if (stat.delta >= -cohort.coverageNonInferiorityMargin) continue;
    const failure: GateFailure = {
      code: isRequired
        ? "coverage_below_non_inferiority_margin"
        : "optional_coverage_below_quality_margin",
      symbol: null,
      detail: `${stat.fieldId}: candidate covers ${(stat.candidateRate * 100).toFixed(1)}% vs legacy ${(stat.legacyRate * 100).toFixed(1)}% of ${stat.applicable} applicable symbols (Δ ${(stat.delta * 100).toFixed(1)}%, margin ${(cohort.coverageNonInferiorityMargin * 100).toFixed(1)}%)`,
    };
    if (isRequired) safetyFailures.push(failure);
    else if (isScoreAffecting) qualityFailures.push(failure);
  }

  const counts = {
    symbols: cohort.rows.length,
    legacyScored: legacyScored.filter((s) => s.status === "scored").length,
    candidateScored: candidateScored.filter((s) => s.status === "scored").length,
    legacyAbstainedOrFailed: legacyScored.filter((s) => s.status !== "scored").length,
    candidateAbstainedOrFailed: candidateScored.filter((s) => s.status !== "scored").length,
    newlyEligible: deltas.filter((d) => d.flip === "ineligible_to_eligible").length,
    newlyIneligible: deltas.filter((d) => d.flip === "eligible_to_ineligible").length,
    hardSemanticFailures: safetyFailures.filter((f) => f.code === "hard_semantic_failure").length,
  };

  const failures = [...safetyFailures, ...qualityFailures];
  const safetyPass = safetyFailures.length === 0;
  const qualityPass = qualityFailures.length === 0;

  return {
    evaluationId: cohort.evaluationId,
    market: cohort.market,
    evaluationCodeVersion: cohort.evaluationCodeVersion,
    candidatePolicyVersionId: cohort.candidatePolicyVersionId,
    baselinePolicyVersionId: cohort.baselinePolicyVersionId,
    strategyVersion: cohort.strategyVersion,
    asOf: cohort.asOf,
    cohortFingerprint: cohortFingerprint(cohort),
    deltas,
    coverage,
    counts,
    failures,
    safetyFailures,
    qualityFailures,
    safetyPass,
    qualityPass,
    passed: safetyPass && qualityPass,
    requiresOwnerReview,
  };
}
