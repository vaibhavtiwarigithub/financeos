import { councilMemberOf } from "./score-history";

export type CouncilExpectedMember = {
  model: string;
  member: ReturnType<typeof councilMemberOf>;
  source: "api" | "subscription";
  score: number | null;
  status: string;
  reason: string | null;
};

type Config = { participant_models?: unknown; subscription_worker_ids?: unknown } | null;
type Forecast = { model_requested: string; execution_source: string; final_score: unknown };
type Worker = { id: string; expected_model: string; family: string };
type Job = { worker_id: string; round?: number; status: string; failure_code: string | null; result?: unknown };

const models = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
  : [];
const scoreOf = (forecast: Forecast | undefined): number | null => {
  if (forecast?.final_score == null) return null;
  const value = Number(forecast.final_score);
  return Number.isFinite(value) ? value : null;
};
const jobScoreOf = (job: Job | undefined): number | null => {
  if (!job || job.status !== "completed" || !job.result || typeof job.result !== "object") return null;
  const value = (job.result as Record<string, unknown>).score;
  return value == null || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100 ? null : Number(value);
};

/** Report every configured participant, including missing/expired subscription results. */
export function buildCouncilMemberState(config: Config, forecasts: Forecast[], workers: Worker[], jobs: Job[]): CouncilExpectedMember[] {
  const out: CouncilExpectedMember[] = [];
  for (const model of models(config?.participant_models)) {
    const forecast = forecasts.find(f => f.model_requested === model && f.execution_source === "api");
    const score = scoreOf(forecast);
    out.push({ model, member: councilMemberOf(model), source: "api", score,
      status: score != null ? "completed" : "missing", reason: score != null ? null : "API forecast not available" });
  }
  for (const id of models(config?.subscription_worker_ids)) {
    const worker = workers.find(w => w.id === id);
    const model = worker?.expected_model ?? "unregistered worker";
    const forecast = forecasts.find(f => f.model_requested === model && f.execution_source === "subscription");
    const job = jobs.filter(j => j.worker_id === id).sort((a, b) => (b.round ?? 0) - (a.round ?? 0))[0];
    // A completed hybrid member result may precede the batch's terminal transition.
    // Expose its accepted score while preserving the all-members consensus gate.
    const score = scoreOf(forecast) ?? jobScoreOf(job);
    out.push({ model, member: worker ? councilMemberOf(model) : null, source: "subscription", score,
      status: score != null ? "completed" : job?.status === "completed" ? "missing_result" : job?.status ?? "not_queued",
      reason: score != null ? null : job?.failure_code ?? (job?.status === "completed" ? "Completed job has no stored forecast" : worker ? null : "Worker registration missing") });
  }
  // Legacy rows may predate the persisted roster. Show stored forecasts instead of an empty card.
  if (!out.length) for (const forecast of forecasts) {
    const score = scoreOf(forecast);
    out.push({ model: forecast.model_requested, member: councilMemberOf(forecast.model_requested),
      source: forecast.execution_source === "subscription" ? "subscription" : "api", score,
      status: score != null ? "completed" : "missing", reason: null });
  }
  return out;
}
