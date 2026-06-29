import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { gatherSymbols, processSymbol } from "@/lib/research-agent";

export const dynamic = "force-dynamic";

// Called by Windows Task Scheduler at 9 AM weekdays.
// curl -X POST http://localhost:3000/api/agents/research/cron -H "x-cron-secret: <CRON_SECRET>"
export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const entries = await gatherSymbols(supabase);
  const batch = entries.map(e => e.symbol);

  const { data: runRow } = await supabase.from("agent_runs").insert({
    agent_type: "research",
    status: "running",
    symbols: batch,
  } as any).select().single();
  const runId = (runRow as any)?.id ?? null;

  const results: any[] = [];

  for (const entry of entries) {
    try {
      const result = await processSymbol(entry, supabase);
      results.push(result);
    } catch (e) {
      results.push({ symbol: entry.symbol, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const ok = results.filter(r => !r.error).length;
  const errs = results.filter(r => r.error).length;

  if (runId) {
    await supabase.from("agent_runs").update({
      status: "done",
      signals_written: ok,
      result_summary: `cron: ${ok} signals, ${errs} failed | ${batch.join(",")}`,
      completed_at: new Date().toISOString(),
    } as any).eq("id", runId);
  }

  return NextResponse.json({ success: true, processed: results.length, ok, errors: errs, symbols: batch, results });
}
