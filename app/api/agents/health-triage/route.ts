import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { callLLM } from "@/lib/llm-router";
import { getConfiguredModel, isAgentEnabled } from "@/lib/agent-model-config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET — latest triage (owner-only), for the dashboard System Health card.
export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const { data } = await svc.from("health_triage").select("content, model, open_alerts, critical_alerts, structured_issues, ts").order("ts", { ascending: false }).limit(1).maybeSingle();
  return NextResponse.json({ triage: data ?? null });
}

// POST — run the health-triage agent. Cron-gated OR owner-gated. READ-ONLY: it reads
// health signals and writes an advisory triage. It is deliberately given NO tools and NO
// write path to money/config/order/weight/code state — the hard boundary from the
// self-healing-agent architecture. It can diagnose and suggest; a human acts.
export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const svc = createServiceClient();
  if (!(await isAgentEnabled(svc, "health-triage"))) {
    return NextResponse.json({ ok: false, error: "health-triage is disabled in Settings → Agents → LLM Config" }, { status: 200 });
  }

  const startedAt = new Date().toISOString();

  // ── Read-only health inputs ──
  const [{ data: alerts }, { data: runs }, { data: quality }, { data: budgets }] = await Promise.all([
    svc.from("agent_alerts").select("severity, category, title, detail, created_at")
      .eq("resolved", false).or("auto_expire_at.is.null,auto_expire_at.gt.now()")
      .order("created_at", { ascending: false }).limit(40),
    svc.from("agent_runs").select("agent_type, market, status, error, started_at")
      .eq("status", "error").gte("started_at", new Date(Date.now() - 48 * 3600 * 1000).toISOString())
      .order("started_at", { ascending: false }).limit(20),
    svc.from("v_decision_quality").select("market, data_confidence, quality_status")
      .gte("ts", new Date(Date.now() - 24 * 3600 * 1000).toISOString()).limit(200),
    svc.from("provider_budget_7d").select("*").limit(40).then((r: any) => r, () => ({ data: null as any[] | null })),
  ]);

  const openAlerts = alerts ?? [];
  const criticalCount = openAlerts.filter((a: any) => String(a.severity).toLowerCase() === "critical").length;

  // Compact, deterministic quality summary per market (no raw dump into the prompt).
  const qByMkt: Record<string, { n: number; low: number; unknown: number }> = {};
  for (const q of quality ?? []) {
    const m = (q as any).market ?? "?";
    qByMkt[m] ??= { n: 0, low: 0, unknown: 0 };
    qByMkt[m].n++;
    if ((q as any).quality_status !== "ok") qByMkt[m].unknown++;
    else if (Number((q as any).data_confidence) < 0.5) qByMkt[m].low++;
  }
  const qualityText = Object.entries(qByMkt).map(([m, v]) => `${m.toUpperCase()}: ${v.low}/${v.n} low-confidence, ${v.unknown} unknown (24h)`).join("; ") || "no decisions in 24h";

  const alertsText = openAlerts.map((a: any) => `- [${a.severity}] ${a.category}: ${a.title} — ${a.detail ?? ""}`.slice(0, 300)).join("\n") || "none";
  const errText = (runs ?? []).map((r: any) => `- ${r.agent_type}${r.market ? `(${r.market})` : ""}: ${r.error ?? "error"}`.slice(0, 250)).join("\n") || "none";
  const budgetText = (budgets ?? []).map((b: any) => `${b.provider ?? "?"}: ${b.calls_today ?? b.calls ?? "?"} calls`).join(", ").slice(0, 800) || "n/a";

  const prompt = `You are the site-reliability engineer for an automated trading research app (Kairos). Using ONLY the health signals below, produce a structured triage in JSON.

HARD RULES: advisory only. Do NOT instruct any trade, do NOT propose changing money limits, weights, model config, credentials, or code autonomously — only describe the human-actionable fix. Do not invent issues not present below. If something is expected/benign (e.g. a daily broker token expiry), include it with severity "info".

OPEN ALERTS (${openAlerts.length}, ${criticalCount} critical):
${alertsText}

AGENT ERRORS (last 48h):
${errText}

DATA QUALITY (v_decision_quality): ${qualityText}

PROVIDER BUDGETS (7d): ${budgetText}

Output ONLY valid JSON matching this exact schema (no markdown, no preamble):
{
  "summary": "one-sentence overall system status",
  "issues": [
    {
      "issue_key": "stable-kebab-case-key matching the agent_alerts issue_key if one exists",
      "severity": "critical|warn|info",
      "root_cause": "one-line root cause",
      "blast_radius": "what is affected",
      "suggested_fix": "concrete human-actionable step"
    }
  ]
}

Rank issues most-urgent first. If no issues, return an empty issues array.`;

  let content = "";
  let structuredIssues: unknown[] | null = null;
  let model = "deepseek-v4-flash";
  let tokensIn = 0, tokensOut = 0;
  try {
    model = await getConfiguredModel(svc, "health-triage", "deepseek-v4-flash");
    const res = await callLLM({ task: "summarize", prompt, model, maxTokens: 700, agentLabel: "health-triage" });
    const raw = res.text?.trim() ?? "";
    tokensIn = res.tokensIn ?? 0; tokensOut = res.tokensOut ?? 0;

    // Parse structured JSON; fall back to storing raw text as summary if parse fails.
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        content = parsed.summary ?? raw;
        structuredIssues = Array.isArray(parsed.issues) ? parsed.issues : null;
      } else {
        content = raw;
      }
    } catch {
      content = raw;
    }
  } catch (e) {
    await svc.from("agent_runs").insert({ agent_type: "health_triage", status: "error", error: String(e), started_at: startedAt, completed_at: new Date().toISOString(), trigger_source: isCron ? "cron" : "manual" });
    return NextResponse.json({ ok: false, error: `LLM unavailable: ${String(e)}` }, { status: 200 });
  }
  if (!content) {
    await svc.from("agent_runs").insert({ agent_type: "health_triage", status: "error", error: "empty triage", started_at: startedAt, completed_at: new Date().toISOString(), trigger_source: isCron ? "cron" : "manual" });
    return NextResponse.json({ ok: false, error: "empty triage" }, { status: 200 });
  }

  await svc.from("health_triage").insert({ content, model, open_alerts: openAlerts.length, critical_alerts: criticalCount, tokens_input: tokensIn, tokens_output: tokensOut, structured_issues: structuredIssues ?? undefined });
  await svc.from("agent_runs").insert({
    agent_type: "health_triage", status: "done",
    result_summary: `Triaged ${openAlerts.length} open alert(s), ${criticalCount} critical`,
    tokens_input: tokensIn, tokens_output: tokensOut,
    started_at: startedAt, completed_at: new Date().toISOString(), trigger_source: isCron ? "cron" : "manual",
  });

  return NextResponse.json({ ok: true, content, model, open_alerts: openAlerts.length, critical_alerts: criticalCount, structured_issues: structuredIssues ?? [] });
}
