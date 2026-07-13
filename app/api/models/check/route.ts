import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { getProviderKey } from "@/lib/llm-keys";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Fortnightly-ish model/LLM freshness check (Ops spec Part 3). Purely
// informational — NEVER auto-switches a model. A human reviews and changes
// the assignment in the existing Agents → agent-config UI.

interface ProviderResult { ok: boolean; models?: string[]; error?: string }

async function checkAnthropic(): Promise<ProviderResult> {
  const key = await getProviderKey("anthropic");
  if (!key) return { ok: false, error: "No ANTHROPIC_API_KEY configured" };
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: `Anthropic ${res.status}` };
    const data = await res.json();
    return { ok: true, models: (data.data ?? []).map((m: any) => m.id) };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

async function checkGroq(): Promise<ProviderResult> {
  const key = await getProviderKey("groq");
  if (!key) return { ok: false, error: "No GROQ_API_KEY configured" };
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: `Groq ${res.status}` };
    const data = await res.json();
    return { ok: true, models: (data.data ?? []).map((m: any) => m.id) };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

async function checkDeepSeek(): Promise<ProviderResult> {
  const key = await getProviderKey("deepseek");
  if (!key) return { ok: false, error: "No DEEPSEEK_API_KEY configured" };
  try {
    const res = await fetch("https://api.deepseek.com/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: `DeepSeek ${res.status}` };
    const data = await res.json();
    return { ok: true, models: (data.data ?? []).map((m: any) => m.id) };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

function providerOf(model: string): "anthropic" | "groq" | "deepseek" | "unknown" {
  if (/claude/i.test(model)) return "anthropic";
  if (/deepseek/i.test(model)) return "deepseek";
  return "groq"; // llama/mixtral/etc served via Groq in this app
}

// Heuristic "newer": same family prefix (text before last version-ish token) with a higher trailing number/date.
function familyPrefix(model: string): string {
  return model.replace(/[-_]?(v?\d[\d.]*|\d{8}|\d{6})$/i, "");
}

export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createServiceClient();
  const { data: agentConfig } = await svc.from("agent_config").select("agent_name, model");
  const assignments = (agentConfig ?? []) as { agent_name: string; model: string }[];

  const [anthropic, groq, deepseek] = await Promise.all([checkAnthropic(), checkGroq(), checkDeepSeek()]);
  const providers = { anthropic, groq, deepseek };

  const findings: { agent: string; assigned: string; kind: "newer_available" | "deprecated"; detail: string }[] = [];

  for (const a of assignments) {
    const provider = providerOf(a.model);
    const result = (providers as any)[provider] as ProviderResult;
    // An EMPTY model list (200 but data.data missing / transient provider blip)
    // must NOT imply every model is deprecated — that's how a DeepSeek hiccup
    // raised 17 false "deprecated" criticals. Treat empty as "couldn't verify".
    if (!result?.ok || !result.models || result.models.length === 0) continue;

    if (!result.models.includes(a.model)) {
      findings.push({ agent: a.agent_name, assigned: a.model, kind: "deprecated", detail: `${a.model} no longer appears in ${provider}'s model list — may be deprecated.` });
      continue;
    }
    const prefix = familyPrefix(a.model);
    const family = result.models.filter(m => familyPrefix(m) === prefix && m !== a.model);
    const newer = family.filter(m => m > a.model); // lexical compare works for date-suffixed / semver-ish ids
    if (newer.length > 0) {
      findings.push({ agent: a.agent_name, assigned: a.model, kind: "newer_available", detail: `${newer[0]} available (assigned: ${a.model}).` });
    }
  }

  await svc.from("model_check_results").insert({
    findings, providers_ok: { anthropic: anthropic.ok, groq: groq.ok, deepseek: deepseek.ok },
  } as any);

  // Funnel into System Health. Deprecated models are one PERSISTENT open issue
  // per (agent, model). They self-resolve the moment the agent is reassigned or
  // the model reappears — but ONLY for providers we actually reached this run, so
  // a transient provider outage never mass-resolves real deprecations.
  // "Reachable" = returned a NON-EMPTY model list. An empty list can neither
  // prove a deprecation nor prove one is fixed, so it must not raise OR resolve.
  const reachable = new Set(
    Object.entries(providers)
      .filter(([, r]) => {
        const pr = r as ProviderResult;
        return pr?.ok && Array.isArray(pr.models) && pr.models.length > 0;
      })
      .map(([p]) => p),
  );
  const deprecatedActive = findings
    .filter(f => f.kind === "deprecated" && reachable.has(providerOf(f.assigned)))
    .map(f => ({
      issueKey: `model-deprecated:${f.agent}:${f.assigned}`,
      severity: "critical" as const,
      category: "models",
      title: `${f.agent} points at a deprecated model (${f.assigned})`,
      detail: `${f.detail} Reassign in Agents → Model Config. Until then the agent falls back to a same-tier model (see llm-router).`,
    }));
  const activeKeys = new Set(deprecatedActive.map(a => a.issueKey));
  for (const a of deprecatedActive) await reportIssue(a, svc);
  // Resolve stale deprecation alerts — but skip keys whose provider was
  // unreachable this run (we can't prove they're fixed).
  const { data: openDep } = await svc.from("agent_alerts")
    .select("issue_key").eq("resolved", false).like("issue_key", "model-deprecated:%");
  for (const row of openDep ?? []) {
    const k = (row as any).issue_key as string;
    if (!k || activeKeys.has(k)) continue;
    const model = k.split(":").slice(2).join(":"); // model-deprecated:<agent>:<model>
    if (reachable.has(providerOf(model))) await resolveIssue(k, svc);
  }

  // Newer-available is advisory, not a fault — one info issue, auto-expiring.
  const newer = findings.filter(f => f.kind === "newer_available");
  if (newer.length > 0) {
    await reportIssue({
      issueKey: "model-newer-available",
      severity: "info", category: "models",
      title: `${newer.length} newer model(s) available for review`,
      detail: newer.map(f => `${f.agent}: ${f.detail}`).join(" · "),
      autoExpireAt: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
    }, svc);
  } else {
    await resolveIssue("model-newer-available", svc);
  }

  return NextResponse.json({ success: true, findings, providers_ok: { anthropic: anthropic.ok, groq: groq.ok, deepseek: deepseek.ok } });
}

export async function GET() {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { data: agentConfig } = await svc.from("agent_config").select("agent_name, model");
  const { data: latest } = await svc.from("model_check_results").select("*").order("checked_at", { ascending: false }).limit(1).maybeSingle();
  return NextResponse.json({ agentConfig: agentConfig ?? [], latest: latest ?? null });
}
