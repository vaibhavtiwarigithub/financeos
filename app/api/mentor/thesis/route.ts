import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/service";
import { callLLM } from "@/lib/llm-router";
import { getConfiguredModel } from "@/lib/agent-model-config";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

// This route declared NO maxDuration and inherited the platform default, which a
// reasoning call cannot finish inside. Measured 2026-09-02, a floored
// mentor-evaluate call took 94.8s end to end (deepseek-v4-pro, 16k budget,
// 3,913 output tokens). That run was verified on a LOCAL dev server, which has
// no function timeout — in production it would have been killed, so "verified
// working" locally proved the model, not the deployment.
export const maxDuration = 150;

// Cache thesis for 24h — regenerate once per day after morning cron.
// Keyed BY MARKET: the thesis is built from that market's signals, so a single
// time-keyed singleton would hand the US thesis to India (and vice versa) for up
// to 24h. One entry per market, never shared.
type CacheEntry = { thesis: string; generatedAt: string; ts: number };
const cache = new Map<Market, CacheEntry>();
const TTL = 24 * 60 * 60 * 1000;

type Market = "us" | "india";
const readMarket = (v: string | null): Market => (v === "india" ? "india" : "us");

export async function GET(req: Request) {
  const gate = await requireOwner();
  if (gate) return gate;
  const params = new URL(req.url).searchParams;
  const bust = params.has("bust");
  // Client passes ?market=; fall back to the `mkt` cookie so a direct hit still
  // resolves to the market the rest of the app is showing.
  const cookieStore = await cookies();
  const market = readMarket(params.get("market") ?? cookieStore.get("mkt")?.value ?? null);

  const hit = cache.get(market);
  if (!bust && hit && Date.now() - hit.ts < TTL) {
    return NextResponse.json({ ...hit, market, source: "cache" });
  }

  const supabase = createServiceClient();

  const [{ data: packets }, { data: log }, { data: signals }] = await Promise.all([
    supabase
      .from("research_packets")
      .select("symbol, summary, key_risks, catalysts, fundamental_score, technical_score, sentiment_score, is_held_position, created_at")
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("learning_log")
      .select("note, created_at")
      .order("created_at", { ascending: false })
      .limit(5),
    // Scoped: signals carry `market`, so the thesis reasons about one book only.
    // research_packets / learning_log above have NO market column — they stay
    // global by necessity, not by choice.
    supabase
      .from("agent_signals")
      .select("symbol, direction, analyst_score, status")
      .eq("market", market)
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  if (!packets || packets.length === 0) {
    return NextResponse.json({
      thesis: null,
      generatedAt: null,
      source: "empty",
      message: "No research data yet. Run ResearchAgent to generate the first market thesis.",
    });
  }

  const context =
    "Recent research:\n" + packets.map((p: any) =>
      `${p.symbol}${p.is_held_position ? " (held)" : ""}: ${p.summary ?? ""} | risks: ${p.key_risks ?? ""}`
    ).join("\n") +
    (log?.length ? "\n\nLearning notes:\n" + log.map((l: any) => `• ${l.note}`).join("\n") : "") +
    (signals?.length ? "\n\nSignals: " + signals.map((s: any) => `${s.symbol} ${s.direction} score:${s.analyst_score}`).join(", ") : "");

  const prompt = `You are a senior portfolio manager. Based on the research data below, write a plain-English current market thesis in 3-4 short paragraphs.

Cover:
1. What sectors/themes the research is currently bullish or cautious on, and WHY (specific reasoning from the data)
2. Key assumptions the portfolio is making right now (e.g. "we're assuming rates plateau", "we favor momentum over value this quarter")
3. What would change your mind (what signals or events would flip the thesis)
4. What risks you're watching most closely

Write as a senior investor briefing a junior. Honest, specific, no generic platitudes.

Data:
${context}

Keep it under 300 words. Plain English, no bullet points.`;

  try {
    // Production LLM path (was execClaude → PowerShell, which ENOENTs on Vercel).
    const res = await callLLM({ task: "thesis", prompt, agentLabel: "mentor-thesis", model: await getConfiguredModel(supabase, "mentor-thesis", "deepseek-reasoner") });
    const thesis = res.text;
    const now = new Date().toISOString();

    cache.set(market, { thesis, generatedAt: now, ts: Date.now() });
    return NextResponse.json({ thesis, generatedAt: now, market, source: "live", meta: { agent: "Market Thesis", agentKind: "grounded", model: res.model } });
  } catch (err) {
    // Stale fallback must also be this market's — never another book's thesis.
    const stale = cache.get(market);
    if (stale) return NextResponse.json({ ...stale, market, source: "stale" });
    return NextResponse.json({ thesis: null, generatedAt: null, market, source: "error", error: String(err) });
  }
}
