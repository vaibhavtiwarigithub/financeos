import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import {
  buildAgentFindings,
  buildDimensionFindings,
  diagnosticFingerprint,
  DIAGNOSTIC_HORIZONS,
  DIMENSION_DIAGNOSTIC_PLAN_VERSION,
  type DiagnosticObservation,
} from "@/lib/learning/dimension-diagnostics";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Market = "us" | "india";

function marketFrom(request: NextRequest): Market | null {
  const value = new URL(request.url).searchParams.get("market");
  return value === "us" || value === "india" ? value : null;
}

async function agentLabels(svc: any, ids: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (let index = 0; index < ids.length; index += 500) {
    const { data, error } = await svc.from("agent_signals").select("id,agent_label").in("id", ids.slice(index, index + 500));
    if (error) throw new Error(`agent label query failed: ${error.message}`);
    for (const row of data ?? []) result.set(String((row as any).id), String((row as any).agent_label ?? "research"));
  }
  return result;
}

async function loadObservations(svc: any, market: Market, horizonDays: number): Promise<DiagnosticObservation[]> {
  const { data, error } = await svc
    .from("observation_labels")
    .select("id,observation_id,horizon_days,benchmark_neutral_return,decision_observations!inner(id,ts,symbol,market,code_version,analyst_score,fundamental_score,technical_score,sentiment_score,macro_score,insider_score,availability_mask,entry_eligible,action,signal_id)")
    .eq("horizon_days", horizonDays)
    .eq("decision_observations.market", market)
    .not("benchmark_neutral_return", "is", null)
    .limit(20000);
  if (error) throw new Error(`label query failed: ${error.message}`);
  const sourceRows = (data ?? []) as any[];
  const signalIds: string[] = sourceRows.map((row) => {
    const decision = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
    return decision?.signal_id;
  }).filter((id: unknown): id is string => typeof id === "string");
  const labels = await agentLabels(svc, [...new Set(signalIds)]);
  return sourceRows.flatMap((row) => {
    const decision = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
    if (!decision?.id || !decision.ts) return [];
    return [{
      id: Number(decision.id), ts: String(decision.ts), symbol: String(decision.symbol), codeVersion: decision.code_version == null ? null : String(decision.code_version), analystScore: decision.analyst_score == null ? null : Number(decision.analyst_score),
      scores: {
        fundamental: decision.fundamental_score == null ? null : Number(decision.fundamental_score),
        technical: decision.technical_score == null ? null : Number(decision.technical_score),
        sentiment: decision.sentiment_score == null ? null : Number(decision.sentiment_score),
        macro: decision.macro_score == null ? null : Number(decision.macro_score),
        insider: decision.insider_score == null ? null : Number(decision.insider_score),
      },
      availabilityMask: decision.availability_mask ?? null,
      benchmarkNeutralReturn: Number(row.benchmark_neutral_return), entryEligible: decision.entry_eligible === true,
      action: String(decision.action ?? "scored"), agentLabel: decision.signal_id ? labels.get(String(decision.signal_id)) ?? "research" : "research",
    }];
  });
}

async function runMarket(svc: any, market: Market) {
  const asOfDate = new Date().toISOString().slice(0, 10);
  const codeVersion = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  const reports: Array<Record<string, unknown>> = [];
  for (const horizonDays of DIAGNOSTIC_HORIZONS) {
    const observations = await loadObservations(svc, market, horizonDays);
    const fingerprint = diagnosticFingerprint(market, horizonDays, observations);
    const { data: existing, error: existingError } = await svc.from("dimension_diagnostic_runs")
      .select("id,status").eq("market", market).eq("analysis_plan_version", DIMENSION_DIAGNOSTIC_PLAN_VERSION)
      .eq("as_of_date", asOfDate).eq("horizon_days", horizonDays).maybeSingle();
    if (existingError) throw new Error(`run lookup failed: ${existingError.message}`);
    if (existing) {
      reports.push({ horizonDays, status: (existing as any).status, skipped: "already_recorded" });
      continue;
    }
    const findings = [...buildDimensionFindings(observations), ...buildAgentFindings(observations)];
    const distinctSessions = new Set(observations.map((row) => row.ts.slice(0, 10))).size;
    const status = findings.some((finding) => finding.classification === "insufficient_evidence") ? "insufficient_evidence" : "measured";
    const { data: run, error: runError } = await svc.from("dimension_diagnostic_runs").insert({
      market, analysis_plan_version: DIMENSION_DIAGNOSTIC_PLAN_VERSION, as_of_date: asOfDate, horizon_days: horizonDays,
      code_version: codeVersion, input_observation_count: observations.length, mature_label_count: observations.length,
      distinct_session_count: distinctSessions, input_fingerprint: fingerprint, status,
    }).select("id").single();
    if (runError || !run) throw new Error(`run insert failed: ${runError?.message ?? "missing row"}`);
    const rows = findings.map((finding) => ({
      diagnostic_run_id: (run as any).id, market, subject_type: finding.subjectType, subject_key: finding.subjectKey,
      finding_type: finding.findingType, classification: finding.classification, metrics: finding.metrics, reason: finding.reason,
    }));
    const { error: findingError } = await svc.from("dimension_diagnostic_findings").insert(rows);
    if (findingError) throw new Error(`finding insert failed: ${findingError.message}`);
    reports.push({ horizonDays, status, observations: observations.length, distinctSessions, findings: rows.length });
  }
  return reports;
}

export async function GET(request: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const market = marketFrom(request);
  if (!market) return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  const svc = createServiceClient();
  const { data, error } = await svc.from("dimension_diagnostic_runs")
    .select("id,market,analysis_plan_version,as_of_date,horizon_days,status,input_observation_count,mature_label_count,distinct_session_count,created_at,dimension_diagnostic_findings(subject_type,subject_key,finding_type,classification,metrics,reason)")
    .eq("market", market).order("created_at", { ascending: false }).limit(4);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ market, planVersion: DIMENSION_DIAGNOSTIC_PLAN_VERSION, runs: data ?? [], influence: "None. Read-only diagnostics; no score, agent, strategy, paper, live, exit, sizing or broker path reads these records." });
}

export async function POST(request: NextRequest) {
  const cron = verifyCronSecret(request);
  if (!cron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const market = marketFrom(request);
  if (!market) return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  try {
    const reports = await runMarket(createServiceClient(), market);
    return NextResponse.json({ ok: true, market, reports, influence: "None" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "diagnostic run failed" }, { status: 500 });
  }
}
