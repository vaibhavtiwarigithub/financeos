import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { gatherSymbols, processSymbol } from "@/lib/research-agent";
import { prewarmPriceCache } from "@/lib/chart-data";

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

  // Chain PaperTrader automatically after research completes
  let paperTradeResult: any = null;
  try {
    const ptRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/agents/paper-trade`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Service-to-service: pass cron secret so paper-trade can skip user auth if needed
        "x-cron-secret": process.env.CRON_SECRET ?? "",
      },
    });
    paperTradeResult = await ptRes.json();
  } catch (e) {
    paperTradeResult = { error: e instanceof Error ? e.message : String(e) };
  }

  // Pre-warm price_cache for researched symbols + benchmark ETFs (fire async, don't block response)
  const BENCHMARK_SYMBOLS = ["VOO", "QQQ", "SPY", "IWM", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLC"];
  const prewarmSymbols = [...new Set([...batch, ...BENCHMARK_SYMBOLS])];
  prewarmPriceCache(prewarmSymbols, supabase).catch(() => {});

  return NextResponse.json({
    success: true, processed: results.length, ok, errors: errs, symbols: batch,
    paperTrade: paperTradeResult,
  });
}
