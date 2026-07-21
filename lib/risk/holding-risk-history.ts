import type { RiskPosture } from "@/lib/risk/holding-risk";

const LEGACY_GENERIC_TRIM_FORMULAS = new Set(["hr-v1", "hr-v2"]);

export interface EffectiveHoldingRiskPosture {
  posture: RiskPosture;
  sourcePosture: RiskPosture;
  reason: string | null;
}

export function normalizeRiskPosture(value: string | null | undefined): RiskPosture {
  switch (value) {
    case "exit_review":
    case "trim":
    case "review":
    case "insufficient_data":
      return value;
    default:
      return "hold";
  }
}

/**
 * Stored snapshots are immutable evidence, but obsolete advice must not remain
 * actionable in current surfaces. hr-v1/v2 used global concentration references
 * as trim mandates; hr-v3 corrected that category error. Preserve the source
 * posture for audit while presenting the safe current interpretation.
 */
export function effectiveHoldingRiskPosture(
  posture: string | null | undefined,
  reason: string | null | undefined,
  formulaVersion: string,
): EffectiveHoldingRiskPosture {
  const sourcePosture = normalizeRiskPosture(posture);
  if (sourcePosture === "trim" && LEGACY_GENERIC_TRIM_FORMULAS.has(formulaVersion)) {
    return {
      posture: "review",
      sourcePosture,
      reason: `Legacy ${formulaVersion} concentration alert - review only. No trim is recommended without an account-specific objective/cap mandate. Historical reason: ${reason ?? "unavailable"}`,
    };
  }
  return { posture: sourcePosture, sourcePosture, reason: reason ?? null };
}
