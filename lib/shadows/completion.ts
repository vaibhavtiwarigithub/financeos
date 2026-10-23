import type { ShadowProgramStatus } from "./status";
import { SHADOW_EVIDENCE_PROBES } from "./liveness";

export type CompletionState = "repair" | "build_comparison" | "collecting" | "analysis_review" | "result_review" | "parked" | "not_applicable";
export interface CompletionAssessment {
  state: CompletionState; priority: number; title: string; reason: string;
  nextAction: string; owner: string; reviewDate: string | null; overdue: boolean;
  canEnable: false;
}
export interface CollectionEvidence {
  id: string; market: string; verdict: string; note: string;
  rows?: number | null; last_write?: string | null; schedules?: any[];
}
const FAILURES = new Set(["unknown", "frozen", "stale", "empty", "missing_schedule", "inactive_schedule", "unexpected_schedule", "never_run", "failed_schedule_run", "stale_schedule_run"]);

/** Fill presentation gaps with existing source evidence, never an invented statistical gate. */
export function applyCollectionEvidence(program: ShadowProgramStatus, source?: CollectionEvidence): ShadowProgramStatus {
  if (program.lifecycle === "not_applicable") return program;
  if (!program.blockers.includes("Status adapter unavailable.")) return program;
  const probe = SHADOW_EVIDENCE_PROBES[program.id];
  const failed = !source || FAILURES.has(source.verdict);
  const stopped = probe?.mode === "off" || probe?.mode === "inert";
  const lifecycle = failed ? "blocked" : stopped ? "off" : source?.rows ? "collecting" : "idle";
  return { ...program, lifecycle, available: !!source && source.verdict !== "unknown",
    latestAt: source?.last_write ?? null,
    progress: { ...program.progress, completed: source?.rows ?? 0, unit: "persisted source rows · not independent samples", target: null },
    benefitEvidence: `${source?.rows == null ? "Unknown source row count" : `${source.rows} persisted source rows`}. ${source?.note ?? "Collection health unavailable."} No predictive or portfolio-benefit verdict is inferred.`,
    blockers: failed ? [source?.note ?? "Restore the source-health read."]
      : stopped ? [probe?.note ?? "No approved active producer."]
      : ["Source collection is visible, but this program has no complete result-to-adoption assessment in Upgrade Path. Read its existing evaluator before proposing activation."],
    nextAction: failed ? "Repair the collector or source-health read before interpreting evidence."
      : stopped ? "Keep outside the active research queue until its approved producer and test are implemented."
      : "Review the existing market-local evaluator and its declared cohort, horizon, maturity and version; do not enable from a source-row count.",
    details: [...program.details, `Source: ${probe?.table ?? "unregistered"}. ${probe?.note ?? ""}`],
    schedules: source?.schedules ?? program.schedules,
    deployment: { state: failed ? "status_unavailable" : stopped ? "deployed_inactive" : "production_measurement",
      summary: source?.note ?? "Source-health read unavailable.", proof: source?.last_write ? [`Latest source write ${source.last_write}`] : [],
      whyNotNextStage: "Collection does not establish validated benefit or permission to activate." },
  };
}

export function assessCompletion(program: ShadowProgramStatus, source?: CollectionEvidence, now = new Date(), producer?: { state?: string; blockers?: string[] }): CompletionAssessment {
  const date = program.reviewDate ?? null;
  const base = { owner: program.owner, reviewDate: date, overdue: !!date && date < now.toISOString().slice(0, 10), canEnable: false as const };
  const result = (state: CompletionState, priority: number, title: string, reason: string, nextAction = program.nextAction) => ({ ...base, state, priority, title, reason, nextAction });
  if (program.lifecycle === "not_applicable") return result("not_applicable", 99, "Not applicable in this market", "Excluded from this market's active and performance totals.");
  if (!program.available || (source && FAILURES.has(source.verdict)) || ["error", "stale", "unavailable"].includes(producer?.state ?? ""))
    return result("repair", 0, "Repair failed evidence pipeline", source && FAILURES.has(source.verdict) ? source.note : producer?.blockers?.join(" ") || program.blockers[0] || "Evidence cannot be verified.");
  if (program.lifecycle === "off" || program.mainline.implementationScope === "inert_scaffold")
    return result("parked", 5, "Not an active experiment", program.blockers[0] || "No active campaign or implemented source adapter.");
  if (program.attribution.state === "invalid") return result("repair", 0, "Repair invalid comparison", program.attribution.reason);
  if (program.attribution.state === "producer_missing") return result("build_comparison", 1, "Implement the missing outcome comparison", program.attribution.reason, program.attribution.reason);
  if (program.attribution.state === "measured") return result("result_review", 2,
    program.attribution.measurementScope === "synthetic_diagnostic" ? "Synthetic result · not Kairos portfolio" : "Paired portfolio result available",
    `${program.attribution.reason} Historical result; all program-specific validation and activation gates remain separate.`);
  if (["exogenous-risk", "pit-fundamental-qualification"].includes(program.id))
    return result("build_comparison", 1, "Implement the declared qualification assessment", program.blockers.join(" ") || "Source collection is not a completed qualification assessment.");
  if (program.lifecycle === "ready_for_review") return result("analysis_review", 2, "Analysis available · not ready to enable", program.blockers.join(" ") || "Review the declared analysis, not a deployment permission.");
  if (program.blockers.some(blocker => blocker.includes("no complete result-to-adoption assessment")))
    return result("build_comparison", 1, "Connect the existing evaluator", "Source rows are arriving, but the result assessment is not connected to this page. This is implementation work, not a need to wait for more rows.");
  if (program.progress.target == null && program.attribution.state !== "collecting" && program.attribution.comparisonType !== "operational_only")
    return result("build_comparison", 1, "Define a finishable test", "No finite comparison or maturity target is declared.");
  return result("collecting", 3, "Collect the declared evidence", program.attribution.state === "collecting" ? program.attribution.reason : program.blockers.join(" ") || "No validated effect is claimed.");
}

export function summarizeCompletion(programs: readonly { lifecycle: string; completion: CompletionAssessment }[]) {
  const applicable = programs.filter(p => p.lifecycle !== "not_applicable");
  return { applicable: applicable.length, repair: applicable.filter(p => p.completion.state === "repair").length,
    buildComparison: applicable.filter(p => p.completion.state === "build_comparison").length,
    collecting: applicable.filter(p => p.completion.state === "collecting").length,
    results: applicable.filter(p => ["result_review", "analysis_review"].includes(p.completion.state)).length,
    parked: applicable.filter(p => p.completion.state === "parked").length,
    overdue: applicable.filter(p => p.completion.overdue).length };
}
