import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { runAgentLoop, ToolCall } from "@/lib/llm-router";
import { getConfiguredModel } from "@/lib/agent-model-config";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Ask the Agent — a TOOL-USING retrieval agent (upgraded 2026-07-12 from a fixed
// recent-rows snapshot). Given the user's question it CALLS TOOLS to fetch the
// exact data the question needs — a specific symbol's research/signals/trades, or
// the recent activity feed — then answers grounded on the results. This is why the
// answer differs from a raw LLM: it reads YOUR system's real data, targeted to the
// question, not a generic guess. Streams the final answer word-by-word (the loop
// itself isn't streamed) with an attribution meta event first.
export async function POST(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  const { question, symbol } = await req.json();
  if (!question?.trim()) return new Response(JSON.stringify({ error: "question required" }), { status: 400 });

  const svc = createServiceClient();
  const model = await getConfiguredModel(svc, "mentor-ask", "deepseek-chat");

  async function toolExecutor(call: ToolCall): Promise<string> {
    try {
      switch (call.name) {
        case "lookup_symbol": {
          const sym = String((call.arguments as any)?.symbol ?? "").toUpperCase().trim();
          if (!sym) return JSON.stringify({ error: "symbol required" });
          const [{ data: packets }, { data: signals }, { data: trades }] = await Promise.all([
            svc.from("research_packets").select("symbol, summary, key_risks, catalysts, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, direction, conviction, created_at").eq("symbol", sym).order("created_at", { ascending: false }).limit(3),
            svc.from("agent_signals").select("direction, analyst_score, rationale, status, created_at").eq("symbol", sym).order("created_at", { ascending: false }).limit(5),
            svc.from("paper_trades").select("order_side, qty, fill_price, exit_price, realized_pnl, pnl_pct, outcome, executed_at, closed_at, rationale").eq("symbol", sym).order("executed_at", { ascending: false }).limit(10),
          ]);
          return JSON.stringify({ symbol: sym, research_packets: packets ?? [], signals: signals ?? [], paper_trades: trades ?? [] });
        }
        case "recent_activity": {
          const n = Math.min(Number((call.arguments as any)?.limit ?? 10) || 10, 25);
          const [{ data: signals }, { data: trades }, { data: log }] = await Promise.all([
            svc.from("agent_signals").select("symbol, direction, analyst_score, status, rationale, created_at").order("created_at", { ascending: false }).limit(n),
            svc.from("paper_trades").select("symbol, order_side, qty, fill_price, pnl_pct, outcome, executed_at, closed_at").order("executed_at", { ascending: false }).limit(n),
            svc.from("learning_log").select("note, created_at").order("created_at", { ascending: false }).limit(n),
          ]);
          return JSON.stringify({ recent_signals: signals ?? [], recent_trades: trades ?? [], learning_notes: (log ?? []).map((l: any) => l.note) });
        }
        case "list_open_positions": {
          const { data: pos } = await svc.from("paper_positions").select("symbol, qty, avg_cost, current_price, market, opened_at").order("opened_at", { ascending: false }).limit(50);
          return JSON.stringify({ open_positions: pos ?? [] });
        }
        case "worst_and_best_trades": {
          const { data: closed } = await svc.from("paper_trades").select("symbol, pnl_pct, realized_pnl, outcome, rationale, executed_at, closed_at").not("closed_at", "is", null).order("pnl_pct", { ascending: true }).limit(50);
          const rows = closed ?? [];
          return JSON.stringify({ worst_5: rows.slice(0, 5), best_5: [...rows].reverse().slice(0, 5), total_closed: rows.length });
        }
        case "finish":
          return JSON.stringify(call.arguments);
        default:
          return JSON.stringify({ error: `Unknown tool: ${call.name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: `tool ${call.name} failed: ${String(e)}` });
    }
  }

  const TOOLS = [
    { name: "lookup_symbol", description: "Everything the system knows about ONE symbol: its recent research packets (thesis + 5 dimension scores + direction/conviction), agent signals, and your paper trades on it. Call this whenever the question names or implies a specific ticker.", parameters: { type: "object", properties: { symbol: { type: "string", description: "Ticker, e.g. NVDA" } }, required: ["symbol"] } },
    { name: "recent_activity", description: "The recent cross-symbol feed: latest agent signals, latest paper trades (with outcomes), and recent LearnerAgent notes. Use for 'what did my system do lately' style questions.", parameters: { type: "object", properties: { limit: { type: "integer", description: "rows per stream, max 25" } } } },
    { name: "list_open_positions", description: "All currently open paper positions (symbol, qty, avg cost, current price, market).", parameters: { type: "object", properties: {} } },
    { name: "worst_and_best_trades", description: "Your 5 worst and 5 best CLOSED paper trades by % P&L, with rationale — for 'what's my worst/best trade and why' questions.", parameters: { type: "object", properties: {} } },
    { name: "finish", description: "Return your final answer to the student as plain text.", parameters: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } },
  ];

  const systemPrompt = `You are a senior portfolio manager and investor mentor teaching a junior investor who runs a real agentic quant system (ResearchAgent scores symbols daily; PaperTrader fills; PositionMonitor exits; LearnerAgent tunes weights). You are a TRUE tool-using agent: to answer well you must CALL TOOLS to fetch the student's ACTUAL data, then reason over the results — never guess about their specific positions, signals, or trades.

Method:
1. Read the question. If it names/implies a symbol → lookup_symbol. If it's about recent activity → recent_activity. If about holdings → list_open_positions. If about best/worst trades → worst_and_best_trades. Call as many as needed.
2. Ground EVERY claim in the tool results (cite the real scores, prices, P&L, outcomes). If the data doesn't cover it, say so honestly — do NOT fabricate.
3. Then call finish with a clear, conversational answer (3-6 short paragraphs): explain the reasoning in plain English, reference the real numbers, be honest about mistakes and WHY, and end with 1-2 questions that make the student think. Educational/advisory only — never place trades.`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Attribution meta first — the UI renders a "who answered" chip from this.
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ meta: { agent: "Ask the Agent", agentKind: "agent-loop", model } })}\n\n`));
      try {
        const loop = await runAgentLoop({
          model,
          systemPrompt,
          initialMessage: symbol ? `About ${String(symbol).toUpperCase()}: ${question}` : question,
          tools: TOOLS,
          toolExecutor,
          maxIterations: 8,
          task: "chat",
          agentLabel: "mentor-ask",
          symbol: symbol ? String(symbol).toUpperCase() : undefined,
        });
        // finish(answer) is the intended terminal; fall back to the loop's last text.
        const finishArg = loop.toolCalls.find(c => c.name === "finish")?.result;
        let answer = loop.text;
        try { const p = finishArg ? JSON.parse(finishArg) : null; if (p?.answer) answer = p.answer; } catch { /* keep loop.text */ }
        if (!answer?.trim()) answer = "I couldn't retrieve enough of your data to answer that confidently. Try naming a specific symbol.";

        for (const word of answer.split(" ")) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: word + " " })}\n\n`));
          await new Promise(r => setTimeout(r, 5));
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ meta: { toolsUsed: loop.toolCalls.map(t => t.name).filter(n => n !== "finish"), steps: loop.steps } })}\n\n`));
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
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
