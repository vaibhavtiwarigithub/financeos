import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { execClaude, parseClaudeOutput } from "@/lib/claude-exec";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  const { question, symbol } = await req.json();
  if (!question?.trim()) return new Response(JSON.stringify({ error: "question required" }), { status: 400 });

  const supabase = createServiceClient();

  // Gather context from DB
  const [
    { data: packets },
    { data: trades },
    { data: log },
    { data: signals },
  ] = await Promise.all([
    supabase
      .from("research_packets")
      .select("symbol, summary, key_risks, catalysts, fundamental_score, technical_score, sentiment_score, macro_score, created_at")
      .order("created_at", { ascending: false })
      .limit(symbol ? 10 : 5)
      .then((r: any) => symbol ? supabase.from("research_packets").select("symbol, summary, key_risks, catalysts, fundamental_score, technical_score, sentiment_score, macro_score, created_at").eq("symbol", symbol.toUpperCase()).order("created_at", { ascending: false }).limit(5) : r),
    supabase
      .from("paper_trades")
      .select("symbol, order_side, qty, fill_price, exit_price, realized_pnl, pnl_pct, outcome, executed_at, closed_at, rationale")
      .order("executed_at", { ascending: false })
      .limit(10),
    supabase
      .from("learning_log")
      .select("note, trades_evaluated, created_at")
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("agent_signals")
      .select("symbol, direction, analyst_score, rationale, status, created_at")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const contextBlocks: string[] = [];

  if (packets && packets.length > 0) {
    contextBlocks.push("=== RECENT RESEARCH PACKETS ===\n" +
      packets.map((p: any) =>
        `[${p.symbol} · ${new Date(p.created_at).toLocaleDateString()}]\n` +
        `Summary: ${p.summary ?? "n/a"}\n` +
        `Catalysts: ${p.catalysts ?? "n/a"}\n` +
        `Key risks: ${p.key_risks ?? "n/a"}\n` +
        `Scores — fundamental:${p.fundamental_score} technical:${p.technical_score} sentiment:${p.sentiment_score} macro:${p.macro_score}`
      ).join("\n\n")
    );
  }

  if (signals && signals.length > 0) {
    contextBlocks.push("=== AGENT SIGNALS ===\n" +
      signals.map((s: any) =>
        `${s.symbol} | ${s.direction?.toUpperCase()} | score ${s.analyst_score} | ${s.status} | ${new Date(s.created_at).toLocaleDateString()}\n` +
        (s.rationale ? `Rationale: ${s.rationale}` : "")
      ).join("\n\n")
    );
  }

  if (trades && trades.length > 0) {
    contextBlocks.push("=== PAPER TRADES ===\n" +
      trades.map((t: any) =>
        `${t.symbol} ${t.order_side?.toUpperCase()} ${t.qty}sh @ $${t.fill_price?.toFixed(2)}` +
        (t.outcome ? ` → ${t.outcome?.toUpperCase()} ${t.pnl_pct?.toFixed(1)}%` : " [open]") +
        ` (${new Date(t.executed_at).toLocaleDateString()})`
      ).join("\n")
    );
  }

  if (log && log.length > 0) {
    contextBlocks.push("=== LEARNING LOG ===\n" + log.map((l: any) => `• ${l.note}`).join("\n"));
  }

  const context = contextBlocks.join("\n\n");

  const prompt = `You are a senior portfolio manager and investor mentor. You are teaching a junior investor who wants to understand your decision-making process.

Your student has access to your real trading system. They can see your signals, trades, and outcomes. They want to understand your reasoning — not just the numbers.

Here is your current context (real data from the system):
${context}

The student asks: "${question}"

Respond as a senior mentor would to a junior:
- Explain your reasoning in plain English, no jargon without explanation
- Reference specific data from the context above when relevant (prices, scores, trade outcomes)
- Be honest when you were wrong and say WHY
- Help them build their OWN conviction — don't just tell them what to think
- If something was a mistake, explain what signal you over/under-weighted and what you'd do differently
- Keep it conversational, 3-6 paragraphs max
- End with 1-2 questions to make them think critically about the same situation themselves

If you don't have enough context to answer confidently, say so — don't fabricate data.`;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const stdout = await execClaude(prompt, 120000);
        const answer = parseClaudeOutput(stdout);

        // Stream word by word for a natural feel
        const words = answer.split(" ");
        for (const word of words) {
          const chunk = `data: ${JSON.stringify({ text: word + " " })}\n\n`;
          controller.enqueue(encoder.encode(chunk));
          // tiny artificial delay for streaming feel (5ms)
          await new Promise(r => setTimeout(r, 5));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
