import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Fortnightly-ish model/LLM freshness check (Ops spec Part 3). Purely
// informational — NEVER auto-switches a model. A human reviews and changes
// the assignment in the existing Agents → agent-config UI.

interface ProviderResult { ok: boolean; models?: string[]; error?: string }

async function checkAnthropic(): Promise<ProviderResult> {
  const key = process.env.ANTHROPIC_API_KEY;
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
  const key = process.env.GROQ_API_KEY;
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
  const key = process.env.DEEPSEEK_API_KEY;
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
    if (!result?.ok || !result.models) continue;

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

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  if (findings.length > 0) {
    const deprecated = findings.filter(f => f.kind === "deprecated");
    await fetch(`${appUrl}/api/alerts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        severity: deprecated.length > 0 ? "warn" : "info",
        category: "models",
        title: deprecated.length > 0 ? `Model check: ${deprecated.length} in-use model(s) may be deprecated` : `Model check: ${findings.length} newer model(s) available`,
        detail: findings.map(f => `${f.agent}: ${f.detail}`).join(" · "),
        auto_expire_at: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
      }),
    }).catch(() => {});
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
