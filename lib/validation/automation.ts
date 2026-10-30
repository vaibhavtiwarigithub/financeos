import { validateChallenger, type ValidationResult } from "@/lib/validation/engine";
import { evaluateShadowCandidate, type ForwardPromotionEvidence } from "@/lib/validation/forward-shadow-selector";

export type ValidationAutomationPolicy = {
  market: "us" | "india";
  enabled: boolean;
  auto_shadow_enabled: boolean;
  auto_promote_enabled: boolean;
  max_active_shadows: number;
};

export type AutomatedValidationResult = {
  automation: "disabled" | "validated";
  validation?: ValidationResult;
  shadow?: { activated: boolean; reason?: string };
};

export type ForwardSelectionResult = {
  candidateId: number;
  status: ForwardPromotionEvidence["status"];
  reason: string;
  effectiveWindows: number;
  windowsRequired: number;
  applied?: boolean;
  event?: string;
};

const DISABLED = (market: "us" | "india"): ValidationAutomationPolicy => ({
  market, enabled: false, auto_shadow_enabled: false, auto_promote_enabled: false, max_active_shadows: 0,
});

export async function loadValidationAutomationPolicy(supabase: any, market: "us" | "india"): Promise<ValidationAutomationPolicy> {
  const { data, error } = await supabase.from("strategy_validation_automation")
    .select("market, enabled, auto_shadow_enabled, auto_promote_enabled, max_active_shadows").eq("market", market).maybeSingle();
  if (error) throw new Error(`validation automation policy read failed: ${error.message}`);
  if (!data) return DISABLED(market);
  return {
    market,
    enabled: data.enabled === true,
    auto_shadow_enabled: data.auto_shadow_enabled === true,
    auto_promote_enabled: data.auto_promote_enabled === true,
    max_active_shadows: Number(data.max_active_shadows ?? 0),
  };
}

/**
 * Weekly deterministic selector for learner-created challengers. It writes an
 * immutable progress snapshot while labels mature, then applies one terminal
 * decision through a database-serialized RPC. It never calls a model/provider.
 */
export async function runForwardShadowSelector(supabase: any, input: {
  market: "us" | "india";
}): Promise<ForwardSelectionResult[]> {
  const policy = await loadValidationAutomationPolicy(supabase, input.market);
  if (!policy.enabled || !policy.auto_promote_enabled) return [];

  const { data: shadows, error: shadowError } = await supabase.from("strategy_versions")
    .select("id").eq("market", input.market).eq("state", "shadow_paper")
    .order("created_at", { ascending: true }).limit(Math.max(0, Math.min(1, policy.max_active_shadows)));
  if (shadowError) throw new Error(`forward-shadow candidates read failed: ${shadowError.message}`);

  const results: ForwardSelectionResult[] = [];
  for (const shadow of shadows ?? []) {
    const candidateId = Number(shadow.id);
    const { data: terminal, error: terminalError } = await supabase.from("strategy_promotion_evaluations")
      .select("id,status,reason,effective_windows").eq("strategy_version_id", candidateId)
      .in("status", ["passed", "failed"]).order("evaluated_at", { ascending: false }).limit(1).maybeSingle();
    if (terminalError) throw new Error(`terminal forward-evaluation read failed: ${terminalError.message}`);

    if (terminal) {
      const { data, error } = await supabase.rpc("apply_strategy_shadow_evaluation", { p_evaluation_id: terminal.id });
      if (error) throw new Error(`forward-evaluation application failed: ${error.message}`);
      results.push({
        candidateId, status: terminal.status, reason: terminal.reason,
        effectiveWindows: Number(terminal.effective_windows), windowsRequired: 20,
        applied: data?.applied === true, event: data?.event ?? data?.reason,
      });
      continue;
    }

    const evidence = await evaluateShadowCandidate(supabase, { market: input.market, candidateId });
    const { data: saved, error: saveError } = await supabase.from("strategy_promotion_evaluations").insert({
      strategy_version_id: candidateId,
      market: input.market,
      horizon_sessions: evidence.horizonSessions,
      status: evidence.status,
      reason: evidence.reason,
      observations: evidence.observations,
      qualifying_sessions: evidence.qualifyingSessions,
      effective_windows: evidence.effectiveWindows,
      candidate_mean_net_return: evidence.candidateMeanNetReturn,
      baseline_mean_net_return: evidence.baselineMeanNetReturn,
      paired_difference_mean: evidence.pairedDifferenceMean,
      paired_difference_t: evidence.pairedDifferenceT,
      paired_difference_ci_lower_95: evidence.pairedDifferenceCiLower95,
      evaluation_start: evidence.evaluationStart,
      evaluation_end: evidence.evaluationEnd,
      method: evidence.method,
    }).select("id").single();
    if (saveError) throw new Error(`forward-evaluation persistence failed: ${saveError.message}`);

    let application: any = null;
    if (evidence.status !== "insufficient_evidence") {
      const { data, error } = await supabase.rpc("apply_strategy_shadow_evaluation", { p_evaluation_id: saved.id });
      if (error) throw new Error(`forward-evaluation application failed: ${error.message}`);
      application = data;
    }
    results.push({
      candidateId, status: evidence.status, reason: evidence.reason,
      effectiveWindows: evidence.effectiveWindows, windowsRequired: evidence.windowsRequired,
      applied: application?.applied, event: application?.event ?? application?.reason,
    });
  }
  return results;
}

/** Retry the existing, already-validated shadow transition after a capacity
 * slot opens. This avoids leaving a passed challenger stranded forever merely
 * because another shadow occupied the per-market slot on its first attempt. */
export async function activateValidatedShadow(supabase: any, input: {
  market: "us" | "india";
  challengerId: number;
}): Promise<{ activated: boolean; reason?: string }> {
  const policy = await loadValidationAutomationPolicy(supabase, input.market);
  if (!policy.enabled || !policy.auto_shadow_enabled) return { activated: false, reason: "automation_disabled" };
  const { data: version, error: versionError } = await supabase.from("strategy_versions")
    .select("id,market,state,validation_experiment_id").eq("id", input.challengerId).eq("market", input.market).maybeSingle();
  if (versionError) throw new Error(`validated challenger read failed: ${versionError.message}`);
  if (!version || version.state !== "challenger" || version.validation_experiment_id == null) {
    return { activated: false, reason: "challenger_not_validated" };
  }
  const { data: validation, error: validationError } = await supabase.from("validation_experiments")
    .select("passed").eq("id", version.validation_experiment_id).eq("challenger_id", input.challengerId).maybeSingle();
  if (validationError) throw new Error(`challenger validation read failed: ${validationError.message}`);
  if (validation?.passed !== true) return { activated: false, reason: "validation_not_passed" };
  const { data, error } = await supabase.rpc("activate_strategy_shadow", { p_version_id: input.challengerId });
  if (error) throw new Error(`validated shadow activation failed: ${error.message}`);
  return { activated: data?.activated === true, reason: data?.reason };
}

// Historical validation can only start a bounded non-executing shadow. A
// separate weekly selector may later promote to PAPER after matured evidence.
// Neither function can touch live strategies or broker paths.
export async function runAutomatedValidation(supabase: any, input: {
  market: "us" | "india";
  challengerId: number;
}): Promise<AutomatedValidationResult> {
  const policy = await loadValidationAutomationPolicy(supabase, input.market);
  if (!policy.enabled) return { automation: "disabled" };

  const validation = await validateChallenger(supabase, {
    market: input.market,
    challengerId: input.challengerId,
  });
  if (!validation.passed || !policy.auto_shadow_enabled) return { automation: "validated", validation };

  const { data, error } = await supabase.rpc("activate_strategy_shadow", { p_version_id: input.challengerId });
  if (error) return { automation: "validated", validation, shadow: { activated: false, reason: error.message } };
  return {
    automation: "validated",
    validation,
    shadow: { activated: data?.activated === true, reason: data?.reason },
  };
}
