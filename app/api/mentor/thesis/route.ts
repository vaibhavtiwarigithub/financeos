import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { execClaude, parseClaudeOutput } from "@/lib/claude-exec";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

// Cache thesis for 24h — regenerate once per day after morning cron
let cache: { thesis: string; generatedAt: string; ts: number } | null = null;
const TTL = 24 * 60 * 60 * 1000;

export async function GET(req: Request) {
  const gate = await requireOwner();
  if (gate) return gate;
  const bust = new URL(req.url).searchParams.has("bust");

  if (!bust && cache && Date.now() - cache.ts < TTL) {
    return NextResponse.json({ ...cache, source: "cache" });
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
    supabase
      .from("agent_signals")
      .select("symbol, direction, analyst_score, status")
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
    const stdout = await execClaude(prompt, 90000);
    const thesis = parseClaudeOutput(stdout);
    const now = new Date().toISOString();

    cache = { thesis, generatedAt: now, ts: Date.now() };
    return NextResponse.json({ thesis, generatedAt: now, source: "live" });
  } catch (err) {
    if (cache) return NextResponse.json({ ...cache, source: "stale" });
    return NextResponse.json({ thesis: null, generatedAt: null, source: "error", error: String(err) });
  }
}
