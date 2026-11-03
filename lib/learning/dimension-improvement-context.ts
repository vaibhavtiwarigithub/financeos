import { DIAGNOSTIC_DIMENSIONS, DIMENSION_DIAGNOSTIC_PLAN_VERSION } from "./dimension-diagnostics";

const SAFE_METRICS = new Set(["observations","available","applicable","unavailable","not_applicable","availability_rate",
  "qualifying_sessions","sessions","mean_session_rank_ic","t_stat","horizon_days","independent_windows",
  "n_effective","mature_labels","invalid_or_unknown_session_provenance"]);

/** Evidence context only. Values never write a score, weight or provider policy. */
export function summarizeDimensionImprovementEvidence(findings: any[]) {
  return DIAGNOSTIC_DIMENSIONS.map(dimension => ({ dimension,
    evidenceState: findings.some(row => row.subject_key === dimension) ? "recorded" : "missing_diagnostics",
    findings: findings.filter(row => row.subject_key === dimension).map(row => ({
      type: String(row.finding_type), classification: String(row.classification),
      diagnosticRunId: row.diagnostic_run_id, observedAt: row.created_at,
      metrics: Object.fromEntries(Object.entries(row.metrics ?? {}).filter(([key,value]) => SAFE_METRICS.has(key)
        && (value === null || typeof value === "number" && Number.isFinite(value)))),
    })),
  }));
}

export async function loadDimensionImprovementContext(svc: any, market: "us" | "india") {
  const runs = await svc.from("dimension_diagnostic_runs")
    .select("id,horizon_days,created_at,analysis_plan_version,code_version,status").eq("market",market)
    .eq("analysis_plan_version",DIMENSION_DIAGNOSTIC_PLAN_VERSION)
    .order("created_at",{ascending:false}).limit(36);
  if (runs.error) throw new Error("Dimension diagnostic inventory unavailable");
  const latestByHorizon = new Map<number, any>();
  for (const row of runs.data ?? []) if (!latestByHorizon.has(row.horizon_days)) latestByHorizon.set(row.horizon_days,row);
  const latest = [...latestByHorizon.values()];
  const findings = latest.length ? await svc.from("dimension_diagnostic_findings")
    .select("diagnostic_run_id,subject_key,finding_type,classification,metrics,created_at").eq("market",market)
    .eq("subject_type","dimension").in("diagnostic_run_id",latest.map(row=>row.id)).limit(501) : {data:[],error:null};
  if (findings.error || (findings.data?.length ?? 0)>500) throw new Error("Dimension findings unavailable or exceed bounded context");
  const sourceEvidence = await svc.from("evidence_policy_evaluations")
    .select("candidate_version_id,baseline_version_id,market_session_date,safety_pass,quality_pass,coverage_delta,schema_failures,eligibility_flips,passed,created_at,expires_at")
    .eq("market",market).order("created_at",{ascending:false}).limit(20);
  if (sourceEvidence.error) throw new Error("Source policy comparison evidence unavailable");
  const councilHead=await svc.from("llm_council_ic_runs").select("evaluation_batch_id").eq("market",market)
    .order("evaluated_at",{ascending:false}).limit(1).maybeSingle();
  if(councilHead.error)throw new Error("Council evaluation batch unavailable");
  const council=councilHead.data ? await svc.from("llm_council_ic_runs")
    .select("horizon_days,series_key,forecast_model,cohort_key,observation_count,qualifying_sessions,independent_windows,mean_session_rank_ic,t_stat,classification,evaluated_at")
    .eq("market",market).eq("evaluation_batch_id",councilHead.data.evaluation_batch_id).limit(401) : {data:[],error:null};
  if(council.error || (council.data?.length ?? 0)>400)throw new Error("Council comparison exceeds bounded evidence context or is unavailable");
  return { version:"dimension-improvement-context-v1",market, diagnosticRuns:latest,
    dimensions:summarizeDimensionImprovementEvidence(findings.data ?? []), sourceComparisons:sourceEvidence.data ?? [],
    councilComparisons:council.data ?? [],
    councilMethodNote:"Preserve exact model/series/cohort identities. independent_windows is the evaluator's rough horizon count, not estimated effective sample size. No per-symbol cross-sectional IC or guaranteed availability is implied.",
    authority:"Diagnostic and source-quality evidence only. Missing or immature results are not negative findings or permission to adopt. Propose bounded formula hypotheses using propose_feature; source proposals use write_hypothesis and require entitlement/paired-data review. Preserve actual historical availability and count trials. No change to active formulas or sources is authorized by this context." };
}
