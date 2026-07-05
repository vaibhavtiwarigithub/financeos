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

  // Skip on weekends and US market holidays — no market data = no point running
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dayOfWeek = nowET.getDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return NextResponse.json({ skipped: true, reason: "Weekend — market closed" });
  }
  const mmdd = `${String(nowET.getMonth() + 1).padStart(2, "0")}-${String(nowET.getDate()).padStart(2, "0")}`;
  const US_HOLIDAYS = ["01-01","01-20","02-17","04-18","05-26","06-19","07-04","09-01","11-27","12-25"]; // 2026 approx
  if (US_HOLIDAYS.includes(mmdd)) {
    return NextResponse.json({ skipped: true, reason: `US market holiday (${mmdd})` });
  }

  // Pause check — skip if app is paused
  const { data: cfg } = await supabase.from("strategy_config").select("app_paused").limit(1).single();
  if ((cfg as any)?.app_paused) {
    return NextResponse.json({ skipped: true, reason: "App is paused — research cron disabled" });
  }

  // Idempotency guard — the scheduled trigger fires once at 9 AM, but a manual
  // re-trigger (or a duplicate Task Scheduler firing) minutes later should not
  // re-run the full research pass. Skip if a research run already completed
  // (or is currently running) within the last 30 minutes.
  const guardWindow = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: recentRun } = await supabase
    .from("agent_runs")
    .select("id, status, started_at")
    .eq("agent_type", "research")
    .gte("started_at", guardWindow)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recentRun) {
    return NextResponse.json({
      skipped: true,
      reason: `Research already ran (or is running) within the last 30 minutes — run ${(recentRun as any).id} started at ${(recentRun as any).started_at}`,
    });
  }

  const entries = await gatherSymbols(supabase);
  const batch = entries.map(e => e.symbol);

  const { data: runRow } = await supabase.from("agent_runs").insert({
    agent_type: "research",
    status: "running",
    symbols: batch,
    trigger_source: "scheduled",
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

  // Emit alerts for failures
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  if (errs > 0) {
    const failedSymbols = results.filter(r => r.error).map(r => r.symbol).join(", ");
    await fetch(`${appUrl}/api/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        severity: errs === results.length ? "error" : "warn",
        category: "cron",
        title: `Research: ${errs} symbol${errs > 1 ? "s" : ""} failed`,
        detail: `Failed: ${failedSymbols}. ${ok} succeeded.`,
        auto_expire_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      }),
    }).catch(() => {});
  }
  if (ok === 0 && batch.length > 0) {
    await fetch(`${appUrl}/api/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        severity: "error",
        category: "cron",
        title: "Research cron produced 0 signals",
        detail: `Attempted ${batch.length} symbols, all failed. Check LLM keys and data APIs.`,
        auto_expire_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      }),
    }).catch(() => {});
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

  // Chain Theme Scout (fire async — don't block response, uses cheap Groq)
  fetch(`${appUrl}/api/agents/theme-scout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cron-secret": process.env.CRON_SECRET ?? "" },
  }).catch(() => {});

  // Pre-warm price_cache for researched symbols + benchmark ETFs (fire async, don't block response)
  const BENCHMARK_SYMBOLS = ["VOO", "QQQ", "SPY", "IWM", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLC", "XLP", "XLU", "XLRE", "XLB"];
  const prewarmSymbols = [...new Set([...batch, ...BENCHMARK_SYMBOLS])];
  prewarmPriceCache(prewarmSymbols, supabase).catch(() => {});

  return NextResponse.json({
    success: true, processed: results.length, ok, errors: errs, symbols: batch,
    paperTrade: paperTradeResult,
  });
}
