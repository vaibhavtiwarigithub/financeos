import type { AttributionState } from "@/lib/shadows/attribution";
import type { UpgradePathAttributionClass } from "@/lib/shadows/registry";

export interface AttributionSummaryInput {
  attribution: { comparisonType: UpgradePathAttributionClass; state: AttributionState; measurementScope?: string | null };
}

/** Keep portfolio-performance evidence counts separate from operational lifecycle counts. */
export function summarizeAttribution(programs: readonly AttributionSummaryInput[]) {
  return {
    performanceEligible: programs.filter((program) => program.attribution.comparisonType !== "operational_only").length,
    measured: programs.filter((program) => program.attribution.state === "measured").length,
    syntheticMeasured: programs.filter((program) => program.attribution.state === "measured" && program.attribution.measurementScope === "synthetic_diagnostic").length,
    collecting: programs.filter((program) => program.attribution.state === "collecting").length,
    producerMissing: programs.filter((program) => program.attribution.state === "producer_missing").length,
    invalid: programs.filter((program) => program.attribution.state === "invalid").length,
    notAttributable: programs.filter((program) => program.attribution.state === "not_attributable").length,
  };
}
