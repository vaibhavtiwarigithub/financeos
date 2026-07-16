// Frozen dual-run evaluation — persistence + bound activation (§4, §5, §10).
//
// The decision is made in cohort.ts (pure). This module is the impure shell: it
// writes the immutable evaluation proof + per-symbol detail rows, and calls the
// bound activation RPC.
//
// It CANNOT cut over on its own: `activateEvaluatedPolicy` moves the active
// pointer to a policy version that must already exist. It never creates a policy
// version and never sets router_enabled — creating an enabled version stays a
// separate, explicitly owner-approved act outside this module.

import { createServiceClient } from "@/lib/supabase/service";
import type { Market } from "@/lib/evidence/contracts";
import { gatedIntents } from "@/lib/evidence/intent-classification";
import {
  EVALUATION_CODE_VERSION,
  type CohortEvaluation,
  type FrozenCohort,
} from "@/lib/evidence/evaluation/cohort";

/** Default validity horizon. An evaluation older than this cannot activate. */
export const DEFAULT_EVALUATION_TTL_HOURS = 72;

export interface PersistOptions {
  cohort: FrozenCohort;
  evaluation: CohortEvaluation;
  strategyFingerprint: string;
  /** Organic + forced outage drill results (§7). Stored, never inferred. */
  outageDrills?: Record<string, unknown> | null;
  callUsage?: Record<string, unknown> | null;
  ttlHours?: number;
  client?: any;
}

/**
 * Write the evaluation proof + one detail row per cohort symbol.
 *
 * Detail rows are written for EVERY symbol, including those where either path
 * abstained or failed — §4 requires the cohort to be whole. Returns the
 * evaluation row id that an activation must later bind to.
 */
export async function persistEvaluation(opts: PersistOptions): Promise<string> {
  const svc = opts.client ?? createServiceClient();
  const { cohort, evaluation } = opts;
  const ttl = opts.ttlHours ?? DEFAULT_EVALUATION_TTL_HOURS;

  const { data, error } = await svc
    .from("evidence_policy_evaluations")
    .insert({
      candidate_version_id: cohort.candidatePolicyVersionId,
      baseline_version_id: cohort.baselinePolicyVersionId,
      market: cohort.market,
      // Frozen cohort identity — every input that could move the verdict.
      cohort_fingerprint: evaluation.cohortFingerprint,
      universe_snapshot_id: cohort.universeSnapshotId,
      as_of: cohort.asOf,
      strategy_version: cohort.strategyVersion,
      strategy_fingerprint: opts.strategyFingerprint,
      evaluation_code_version: cohort.evaluationCodeVersion,
      price_basis: cohort.priceBasis,
      score_threshold: cohort.scoreThreshold,
      sample: { symbols: cohort.rows.map((r) => r.symbol), shapes: cohort.rows.map((r) => r.shape) },
      counts: evaluation.counts,
      coverage: evaluation.coverage,
      coverage_delta: Object.fromEntries(evaluation.coverage.map((c) => [c.fieldId, c.delta])),
      failures: evaluation.failures,
      requires_owner_review: evaluation.requiresOwnerReview.map((d) => ({
        symbol: d.symbol, cause: d.cause, note: d.note,
      })),
      required_intents: gatedIntents(cohort.market),
      schema_failures: evaluation.counts.hardSemanticFailures,
      score_delta: Object.fromEntries(evaluation.deltas.map((d) => [d.symbol, d.scoreDelta])),
      eligibility_flips: evaluation.counts.newlyEligible + evaluation.counts.newlyIneligible,
      provider_disagreement: evaluation.deltas
        .filter((d) => d.parity.disagreements.length > 0)
        .map((d) => ({ symbol: d.symbol, codes: d.parity.disagreements.map((x) => x.code) })),
      call_usage: opts.callUsage ?? null,
      outage_drills: opts.outageDrills ?? null,
      passed: evaluation.passed,
      reason: evaluation.passed
        ? (evaluation.requiresOwnerReview.length > 0
          ? "machine gates passed; owner review required before activation"
          : "all machine gates satisfied")
        : evaluation.failures.map((f) => `${f.code}${f.symbol ? `:${f.symbol}` : ""}`).join("; "),
      expires_at: new Date(Date.now() + ttl * 3600_000).toISOString(),
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    // Evidence-record persistence failure is itself a rollback trigger (§9) —
    // an evaluation that cannot be proven cannot be relied on, so this throws
    // rather than returning a phantom id.
    throw new Error(`evaluation persistence failed: ${error?.message ?? "no id returned"}`);
  }
  const evaluationId: string = data.id;

  const rows = evaluation.deltas.map((d) => {
    const row = cohort.rows.find((r) => r.symbol === d.symbol)!;
    return {
      evaluation_id: evaluationId,
      market: cohort.market,
      symbol: d.symbol,
      symbol_shape: row.shape,
      is_held: row.isHeld,
      legacy_status: d.legacy.status,
      candidate_status: d.candidate.status,
      legacy_score: d.legacy.score,
      candidate_score: d.candidate.score,
      score_delta: d.scoreDelta,
      legacy_rank: d.legacy.rank,
      candidate_rank: d.candidate.rank,
      rank_delta: d.rankDelta,
      legacy_direction: d.legacy.direction,
      candidate_direction: d.candidate.direction,
      legacy_eligible: d.legacy.eligible,
      candidate_eligible: d.candidate.eligible,
      flip: d.flip,
      flip_cause: d.cause,
      blocking: d.blocking,
      field_deltas: d.parity.comparisons.map((c) => ({
        fieldId: c.fieldId,
        code: c.code,
        detail: c.detail,
        relativeDelta: c.relativeDelta,
        // Evidence fingerprints: which provider served each side, under what basis.
        legacy: { provider: c.legacy.providerId, basis: c.legacy.basis, period: c.legacy.periodEnd, quality: c.legacy.quality, present: c.legacy.present },
        candidate: { provider: c.candidate.providerId, basis: c.candidate.basis, period: c.candidate.periodEnd, quality: c.candidate.quality, present: c.candidate.present },
      })),
      legacy_included_dims: d.legacy.includedDims,
      candidate_included_dims: d.candidate.includedDims,
      note: d.note,
    };
  });

  // Chunked so a large cohort doesn't exceed a single statement's limits.
  for (let i = 0; i < rows.length; i += 200) {
    const { error: detailError } = await svc
      .from("evidence_evaluation_details")
      .insert(rows.slice(i, i + 200));
    if (detailError) throw new Error(`evaluation detail persistence failed: ${detailError.message}`);
  }

  return evaluationId;
}

// ── bound activation (§5) ────────────────────────────────────────────────────

export interface ActivationRequest {
  market: Market;
  candidateVersionId: string;
  baselineVersionId: string;
  evaluationId: string;
  strategyVersion: string;
  actor?: string | null;
  client?: any;
}

/**
 * Activate a policy version, bound to an exact evaluation.
 *
 * Every axis is bound in the RPC (candidate + baseline + evaluation id + code
 * version + strategy version + market + expiry + owner review), and the RPC
 * raises rather than activating if any of them disagrees. This function passes
 * the CODE's evaluation version — not a caller-supplied string — so a candidate
 * evaluated by older evaluation code can never activate against newer code.
 *
 * Per-market and per-intent-family by construction: `gatedIntents(market)` is
 * this market's own required set; nothing here reads the other market's state.
 */
export async function activateEvaluatedPolicy(req: ActivationRequest): Promise<void> {
  const svc = req.client ?? createServiceClient();
  const { error } = await svc.rpc("activate_evidence_policy_bound", {
    p_market: req.market,
    p_candidate_version_id: req.candidateVersionId,
    p_baseline_version_id: req.baselineVersionId,
    p_evaluation_id: req.evaluationId,
    p_evaluation_code_version: EVALUATION_CODE_VERSION,
    p_strategy_version: req.strategyVersion,
    p_required_intents: gatedIntents(req.market),
    p_actor: req.actor ?? null,
  });
  if (error) throw new Error(`bound activation refused: ${error.message}`);
}
