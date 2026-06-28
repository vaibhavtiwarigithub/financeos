import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { execClaude, parseClaudeOutput } from "@/lib/claude-exec";

function buildPrompt(symbol: string) {
  return `Research ${symbol}. Use any available tools to gather data. Then output your final answer as ONLY a JSON object with EXACTLY these keys (no other keys, no prose, no markdown):

{"symbol":"${symbol}","fundamental_score":75,"technical_score":70,"sentiment_score":72,"macro_score":65,"insider_score":60,"direction":"long","conviction":70,"summary":"thesis here","key_risks":["risk1","risk2"],"catalysts":["cat1","cat2"]}

Replace every value with your actual assessment. Scores are integers 0-100. direction must be exactly: long, short, or neutral. Your entire response is the JSON object above with real values filled in.`;
}

function extractParsed(claudeRaw: string): any {
  const jsonMatches = claudeRaw.match(/\{[\s\S]*\}/g) ?? [];
  for (let i = jsonMatches.length - 1; i >= 0; i--) {
    try {
      const c = JSON.parse(jsonMatches[i]);
      if (typeof c.fundamental_score === "number") return c;
    } catch { continue; }
  }
  const m = claudeRaw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function processSymbol(symbol: string, supabase: any) {
  const stdout = await execClaude(buildPrompt(symbol), 90000);
  const claudeRaw = parseClaudeOutput(stdout);
  const parsed = extractParsed(claudeRaw);
  if (!parsed) throw new Error(`JSON parse failed. Raw: ${claudeRaw.slice(0, 200)}`);

  const rawDirection: string = parsed.direction ?? "neutral";
  const signalDirection = rawDirection === "short" ? "neutral" : rawDirection;

  const { data: packet } = await supabase.from("research_packets").insert({
    symbol: parsed.symbol,
    fundamental_score: parsed.fundamental_score,
    technical_score: parsed.technical_score,
    sentiment_score: parsed.sentiment_score,
    macro_score: parsed.macro_score,
    insider_score: parsed.insider_score,
    summary: parsed.summary,
    key_risks: parsed.key_risks,
    catalysts: parsed.catalysts,
    raw_data: { ...parsed, _original_direction: rawDirection, _direction_override: rawDirection !== signalDirection },
  }).select().single();

  const { data: weights } = await supabase.from("signal_weights").select("*").single();
  const fw = weights?.fundamental_weight ?? 0.30;
  const tw = weights?.technical_weight  ?? 0.25;
  const sw = weights?.sentiment_weight  ?? 0.20;
  const mw = weights?.macro_weight      ?? 0.15;
  const iw = weights?.insider_weight    ?? 0.10;

  const analystScore = Math.round(
    (parsed.fundamental_score * fw) +
    (parsed.technical_score   * tw) +
    (parsed.sentiment_score   * sw) +
    (parsed.macro_score       * mw) +
    (parsed.insider_score     * iw)
  );

  const directionNote = rawDirection !== signalDirection
    ? ` [short overridden to neutral — long-only]` : "";

  await supabase.from("agent_signals").insert({
    symbol: parsed.symbol,
    direction: signalDirection,
    analyst_score: analystScore,
    conviction: parsed.conviction,
    agent_type: "research",
    research_packet_id: packet?.id,
    status: "pending",
    rationale: (parsed.summary ?? "") + directionNote,
  });

  return { symbol: parsed.symbol, analystScore, direction: signalDirection, conviction: parsed.conviction };
}

// ResearchAgent: SSE-streaming POST — sends per-symbol progress events live
export async function POST(req: NextRequest) {
  let symbols: string[];
  try {
    const body = await req.json();
    symbols = body?.symbols;
    if (!symbols || !Array.isArray(symbols) || symbols.length === 0)
      return NextResponse.json({ error: "symbols array required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Auth check via user client; writes use service client (bypasses RLS)
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createServiceClient();
  const batch = symbols.slice(0, 5);
  const enc = new TextEncoder();
  const results: any[] = [];

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: object) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

      for (const symbol of batch) {
        send({ type: "progress", symbol, status: "analyzing" });
        try {
          const result = await processSymbol(symbol, supabase);
          results.push(result);
          send({ type: "result", ...result });
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          results.push({ symbol, error });
          send({ type: "error", symbol, error });
        }
      }

      send({ type: "done", processed: results.length, results });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
