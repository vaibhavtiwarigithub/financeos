import { validateChallenger, type ValidationResult } from "@/lib/validation/engine";

export type ValidationAutomationPolicy = {
  market: "us" | "india";
  enabled: boolean;
  auto_shadow_enabled: boolean;
  max_active_shadows: number;
};

export type AutomatedValidationResult = {
  automation: "disabled" | "validated";
  validation?: ValidationResult;
  shadow?: { activated: boolean; reason?: string };
};

const DISABLED = (market: "us" | "india"): ValidationAutomationPolicy => ({
  market, enabled: false, auto_shadow_enabled: false, max_active_shadows: 0,
});

export async function loadValidationAutomationPolicy(supabase: any, market: "us" | "india"): Promise<ValidationAutomationPolicy> {
  const { data, error } = await supabase.from("strategy_validation_automation")
    .select("market, enabled, auto_shadow_enabled, max_active_shadows").eq("market", market).maybeSingle();
  if (error || !data) return DISABLED(market);
  return {
    market,
    enabled: data.enabled === true,
    auto_shadow_enabled: data.auto_shadow_enabled === true,
    max_active_shadows: Number(data.max_active_shadows ?? 0),
  };
}

// The only automatic lifecycle transition is to non-executing shadow_paper.
// Promotion remains the separate owner-only RPC.
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
