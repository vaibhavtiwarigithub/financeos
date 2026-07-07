import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { callLLM } from "@/lib/llm-router";
import { getConfiguredModel } from "@/lib/agent-model-config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET — return today's cached macro-to-holdings interpretation (owner-only).
export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const market = new URL(req.url).searchParams.get("market") === "india" ? "india" : "us";
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await svc.from("macro_interpretations").select("content, model, created_at, date").eq("market", market).order("date", { ascending: false }).limit(1).maybeSingle();
  return NextResponse.json({ interpretation: data ?? null, stale: !data || (data as any).date !== today });
}

// POST — (re)generate the interpretation. Cron-gated OR owner-gated. Runs a
// cheap model over deterministic inputs (latest macro regime + prints + the
// current book + macro priors). Advisory text only — never changes any
// trading behavior. Cached once/day per market so it costs at most one cheap
// LLM call per macro refresh.
export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const svc = createServiceClient();
  const market = new URL(req.url).searchParams.get("market") === "india" ? "india" : "us";
  const today = new Date().toISOString().slice(0, 10);

  // Skip if already generated today (idempotent; avoids repeat spend).
  const { data: existing } = await svc.from("macro_interpretations").select("id").eq("market", market).eq("date", today).maybeSingle();
  if (existing && !new URL(req.url).searchParams.get("force")) {
    return NextResponse.json({ ok: true, skipped: "already generated today" });
  }

  // Deterministic inputs.
  const { data: regime } = await svc.from("macro_regime").select("week_of, danger_score, regime, summary, raw_indicators").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!regime) return NextResponse.json({ ok: false, error: "no macro regime data yet" }, { status: 200 });
  const { data: positions } = await svc.from("paper_positions").select("symbol, sector, qty").eq("market", market).limit(40);
  const { data: macroPriors } = await svc.from("learning_priors").select("principle, confidence").eq("category", "macro").eq("enabled", true).order("confidence", { ascending: false }).limit(12);

  const book = (positions ?? []).map((p: any) => `${p.symbol}${p.sector ? ` (${p.sector})` : ""}`).join(", ") || "no open positions";
  const priorsText = (macroPriors ?? []).map((p: any) => `- ${p.principle} [confidence ${Math.round(p.confidence * 100)}%]`).join("\n");

  const prompt = `You are a macro strategist. Using ONLY the data below (do not invent any numbers), write a short (4-6 sentence) plain-English read of what the current macro backdrop means for THIS book. Tie the regime and the raw indicators to specific holdings where relevant, and reference the macro principles by their stated confidence. Advisory only.

MARKET: ${market.toUpperCase()}
MACRO REGIME: ${(regime as any).regime} (danger score ${(regime as any).danger_score}/100)
REGIME SUMMARY: ${(regime as any).summary ?? "n/a"}
RAW INDICATORS: ${JSON.stringify((regime as any).raw_indicators ?? {}).slice(0, 1500)}
CURRENT BOOK: ${book}
MACRO PRINCIPLES (the system's beliefs, with confidence):
${priorsText || "none"}

Write the read now. Do not give trade instructions or invent figures not shown above.`;

  let content = "";
  let model = "deepseek-reasoner";
  try {
    model = await getConfiguredModel(svc, "macro-read", "deepseek-reasoner");
    const res = await callLLM({ task: "summarize", prompt, model, maxTokens: 600, agentLabel: "macro-read" });
    content = res.text?.trim() ?? "";
  } catch (e) {
    return NextResponse.json({ ok: false, error: `LLM unavailable: ${String(e)}` }, { status: 200 });
  }
  if (!content) return NextResponse.json({ ok: false, error: "empty interpretation" }, { status: 200 });

  await svc.from("macro_interpretations").upsert({ date: today, market, content, model }, { onConflict: "date,market" });
  return NextResponse.json({ ok: true, content, model });
}
