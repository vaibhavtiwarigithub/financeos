import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { checkRobinhoodTokenHealth } from "@/lib/robinhood-mcp";
import { buildDeterministicTriage } from "@/lib/health/deterministic-triage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Latest deterministic triage for the dashboard. Raw open alerts remain the
// authoritative rows; this record is a compact snapshot with its own timestamp.
export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const { data, error } = await svc
    .from("health_triage")
    .select("content, model, open_alerts, critical_alerts, structured_issues, ts")
    .order("ts", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Health triage unavailable" }, { status: 500 });
  return NextResponse.json({ triage: data ?? null });
}

// Cron- or owner-triggered deterministic reconciliation. No LLM is allowed to
// classify operational truth: current alerts plus the latest run per agent and
// market determine the output. This route remains read-only with respect to
// trading/configuration; it writes only the triage snapshot and its own run log.
export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }

  const svc = createServiceClient();
  const startedAt = new Date().toISOString();

  try { await checkRobinhoodTokenHealth(svc); } catch { /* non-fatal */ }

  const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const [{ data: alerts, error: alertsError }, { data: runs, error: runsError }] = await Promise.all([
    svc.from("agent_alerts")
      .select("issue_key, severity, category, title, detail, created_at")
      .eq("resolved", false)
      .or("auto_expire_at.is.null,auto_expire_at.gt.now()")
      .order("created_at", { ascending: false })
      .limit(100),
    svc.from("agent_runs")
      .select("agent_type, market, status, error, result_summary, started_at")
      .in("status", ["done", "success", "error"])
      .gte("started_at", cutoff)
      .order("started_at", { ascending: false })
      .limit(300),
  ]);

  if (alertsError || runsError) {
    const detail = alertsError?.message ?? runsError?.message ?? "unknown read failure";
    await svc.from("agent_runs").insert({
      agent_type: "health_triage", status: "error", error: detail,
      result_summary: "Deterministic health triage could not read its inputs",
      started_at: startedAt, completed_at: new Date().toISOString(),
      trigger_source: isCron ? "cron" : "manual",
    });
    return NextResponse.json({ error: "Health inputs unavailable" }, { status: 500 });
  }

  const result = buildDeterministicTriage(alerts ?? [], runs ?? []);
  const criticalCount = result.issues.filter((issue) => issue.severity === "critical").length;

  const { error: writeError } = await svc.from("health_triage").insert({
    content: result.summary,
    model: "deterministic-v1",
    open_alerts: (alerts ?? []).length,
    critical_alerts: criticalCount,
    tokens_input: 0,
    tokens_output: 0,
    structured_issues: result.issues,
  });
  if (writeError) return NextResponse.json({ error: "Health triage write failed" }, { status: 500 });

  await svc.from("agent_runs").insert({
    agent_type: "health_triage", status: "done",
    result_summary: `Deterministically triaged ${(alerts ?? []).length} open alert(s), ${criticalCount} critical`,
    tokens_input: 0, tokens_output: 0,
    started_at: startedAt, completed_at: new Date().toISOString(),
    trigger_source: isCron ? "cron" : "manual",
  });

  return NextResponse.json({
    ok: true,
    content: result.summary,
    model: "deterministic-v1",
    open_alerts: (alerts ?? []).length,
    critical_alerts: criticalCount,
    structured_issues: result.issues,
    ts: new Date().toISOString(),
  });
}
