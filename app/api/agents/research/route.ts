import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { gatherSymbols, processSymbol } from "@/lib/research-agent";

export const dynamic = "force-dynamic";

// ResearchAgent: SSE-streaming POST
// Body: {} for auto-gather (holdings + watchlist + screener)
//       { symbols: ["AAPL","NVDA"] } for manual override (debug)
export async function POST(req: NextRequest) {
  let manualSymbols: string[] | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (Array.isArray(body?.symbols) && body.symbols.length > 0) {
      manualSymbols = body.symbols;
    }
  } catch { /* body optional */ }

  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createServiceClient();
  const entries = await gatherSymbols(supabase, manualSymbols);
  const batch = entries.map(e => e.symbol);

  const { data: runRow } = await supabase.from("agent_runs").insert({
    agent_type: "research",
    status: "running",
    symbols: batch,
  } as any).select().single();
  const runId = (runRow as any)?.id ?? null;

  const enc = new TextEncoder();
  const results: any[] = [];

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: object) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

      send({
        type: "symbols",
        symbols: batch,
        sources: entries.map(e => ({ symbol: e.symbol, isHeld: e.isHeld, isEtf: e.isEtf })),
      });

      for (const entry of entries) {
        send({ type: "progress", symbol: entry.symbol, status: "analyzing", isHeld: entry.isHeld, isEtf: entry.isEtf });
        try {
          const result = await processSymbol(entry, supabase);
          results.push(result);
          send({ type: "result", ...result });
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          results.push({ symbol: entry.symbol, error });
          send({ type: "error", symbol: entry.symbol, error });
        }
      }

      const ok = results.filter(r => !r.error).length;
      const errs = results.filter(r => r.error).length;
      if (runId) {
        await supabase.from("agent_runs").update({
          status: "done",
          signals_written: ok,
          result_summary: `${ok} signals written, ${errs} failed | ${batch.join(",")}`,
          completed_at: new Date().toISOString(),
        } as any).eq("id", runId);
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
