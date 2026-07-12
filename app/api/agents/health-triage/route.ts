import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { callLLM } from "@/lib/llm-router";
import { getConfiguredModel, isAgentEnabled } from "@/lib/agent-model-config";
import { checkRobinhoodTokenHealth } from "@/lib/robinhood-mcp";

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

  // ── Proactive broker-token age check (vault-only, no Robinhood API call) ──
  // Runs BEFORE the alert read below so a freshly reported/resolved
  // `broker-token:robinhood` issue is reflected in this same triage. Catches an
  // expired Robinhood token every 6h even when no order/snapshot path ran to
  // surface it lazily — the failure mode that left all RH accounts out of
  // holding-risk. Never throws (system-health helpers swallow errors).
  try { await checkRobinhoodTokenHealth(svc); } catch { /* non-fatal */ }

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
        content = parsed.summary?.trim() || raw;
        structuredIssues = Array.isArray(parsed.issues) ? parsed.issues : null;
      } else {
        content = raw;
      }
    } catch {
      content = raw;
    }
  } catch (e) {
    // LLM failed (both primary + same-tier fallback exhausted). Rather than
    // erroring the cron run and leaving the dashboard blank, produce a rule-based
    // summary from the already-fetched alert/error data — triage still runs, the
    // LLM error is recorded in agent_runs.error for debugging, and the dashboard
    // shows something useful instead of "last triage unavailable".
    content = openAlerts.length === 0
      ? `System healthy — no open alerts. (LLM triage unavailable: ${String(e).slice(0, 120)})`
      : `${openAlerts.length} open alert(s), ${criticalCount} critical. LLM triage unavailable — review alerts in System Health. (${String(e).slice(0, 100)})`;
    structuredIssues = openAlerts.slice(0, 5).map((a: any) => ({
      issue_key: (a.category ?? "open-alert").replace(/\s+/g, "-").toLowerCase(),
      severity: a.severity ?? "warn",
      root_cause: a.title ?? "Open alert",
      blast_radius: a.category ?? "system",
      suggested_fix: a.detail ?? "Review in System Health dashboard",
    }));
    model = "rule-based";
    tokensIn = 0; tokensOut = 0;
    // Record the LLM failure in agent_runs.error without marking status=error
    // (we did produce output, so the cron isn't broken — just degraded).
    await svc.from("agent_runs").insert({
      agent_type: "health_triage", status: "done",
      result_summary: `Rule-based triage (LLM unavailable): ${openAlerts.length} alert(s), ${criticalCount} critical`,
      error: `LLM unavailable: ${String(e).slice(0, 200)}`,
      started_at: startedAt, completed_at: new Date().toISOString(),
      trigger_source: isCron ? "cron" : "manual",
    });
    await svc.from("health_triage").insert({ content, model, open_alerts: openAlerts.length, critical_alerts: criticalCount, tokens_input: 0, tokens_output: 0, structured_issues: structuredIssues });
    return NextResponse.json({ ok: true, content, model, open_alerts: openAlerts.length, critical_alerts: criticalCount, structured_issues: structuredIssues });
  }
  if (!content) {
    // Safety net: LLM succeeded but returned empty summary (shouldn't happen
    // after callDeepSeek throws on empty, but kept as last-resort fallback).
    content = openAlerts.length === 0
      ? "System healthy — no open alerts. (LLM returned empty summary)"
      : `${openAlerts.length} alert(s) open, ${criticalCount} critical. (LLM returned empty summary — check model config)`;
    model += ":empty-fallback";
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
