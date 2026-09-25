import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { benchmarkSymbolFor } from "@/lib/data/benchmark-registry";
import { buildMissedOpportunityMarks, type MissedEntrySnapshot, type MissedCloseRow } from "@/lib/trading/missed-opportunity-marks";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const market = request.nextUrl.searchParams.get("market");
  if (market !== "us" && market !== "india") return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  try {
    const svc = createServiceClient();
    const { data: rows, error } = await svc.from("paper_missed_opportunities").select("*")
      .eq("market", market).order("decision_at", { ascending: false }).limit(100);
    if (error) throw new Error(`missed opportunity query failed: ${error.message}`);
    const events = rows ?? [];
    if (!events.length) return NextResponse.json({ market, benchmark: benchmarkSymbolFor(market, "portfolio"), episodes: [], summary: { count: 0, markedPnl: 0, matureCount: 0 } });
    const eventSymbols = [...new Set(events.map((event: any) => String(event.symbol).toUpperCase()))];
    const symbols = [...eventSymbols, benchmarkSymbolFor(market, "portfolio")];
    const since = events.reduce((min: string, event: any) => String(event.decision_at).slice(0, 10) < min ? String(event.decision_at).slice(0, 10) : min, String(events[0].decision_at).slice(0, 10));
    const benchmarkSinceDate = new Date(`${since}T00:00:00Z`);
    benchmarkSinceDate.setUTCDate(benchmarkSinceDate.getUTCDate() - 10);
    const benchmarkSince = benchmarkSinceDate.toISOString().slice(0, 10);
    const [fills, closes, benchmarkConfig] = await Promise.all([
      fetchAllRows((from, to) => svc.from("paper_trades").select("symbol,executed_at,id").eq("market", market).eq("order_side", "buy").in("symbol", eventSymbols).gte("executed_at", `${since}T00:00:00Z`).order("id", { ascending: true }).range(from, to), "missed-opportunity paper-buy reconciliation"),
      fetchAllRows((from, to) => svc.from("symbol_daily_returns").select("symbol,market,session_date,available_at,price_basis,close,source,id").eq("market", market).in("symbol", eventSymbols).gte("session_date", since).order("id", { ascending: true }).range(from, to), "missed-opportunity symbol closes"),
      svc.from("benchmarks").select("id,symbol,provider_symbol").eq("market", market).eq("is_primary", true).eq("enabled", true).maybeSingle(),
    ]);
    if (benchmarkConfig.error || !benchmarkConfig.data) throw new Error(`registered benchmark unavailable: ${benchmarkConfig.error?.message ?? "primary benchmark missing"}`);
    const symbolCloseRows = closes as MissedCloseRow[];
    const benchmark = benchmarkSymbolFor(market, "portfolio");
    const configuredBenchmark = String(benchmarkConfig.data.provider_symbol ?? benchmarkConfig.data.symbol);
    if (configuredBenchmark !== benchmark) throw new Error(`benchmark registry mismatch: expected ${benchmark}, found ${configuredBenchmark}`);
    const benchmarkCloses = await fetchAllRows((from, to) => svc.from("benchmark_price_observations")
      .select("date,close,created_at,benchmark_id").eq("benchmark_id", benchmarkConfig.data!.id)
      .eq("component_symbol", configuredBenchmark).eq("source_status", "ok").gte("date", benchmarkSince)
      .order("date", { ascending: true }).range(from, to), "missed-opportunity benchmark closes");
    const benchmarkRows: MissedCloseRow[] = benchmarkCloses.map((row: any) => ({ symbol: benchmark, market,
      session_date: String(row.date).slice(0, 10), available_at: String(row.created_at), close: row.close }));
    const episodes = events.map((event: any) => {
      const laterFill = fills.find((fill: any) => String(fill.symbol).toUpperCase() === String(event.symbol).toUpperCase() && fill.executed_at > event.decision_at);
      const args = { snapshot: event as MissedEntrySnapshot,
        symbolCloses: symbolCloseRows.filter(row => row.symbol.toUpperCase() === String(event.symbol).toUpperCase()),
        benchmarkCloses: benchmarkRows, benchmarkSymbol: benchmark,
        subsequentBuyAt: laterFill?.executed_at ?? null };
      return { ...event, marks: buildMissedOpportunityMarks(args), subsequentlyBoughtAt: laterFill?.executed_at ?? null };
    });
    const validPnl = episodes.map((e: any) => e.marks.missedPnl).filter((n: unknown): n is number => typeof n === "number" && Number.isFinite(n));
    return NextResponse.json({ market, benchmark, episodes,
      summary: { count: episodes.length, markedEpisodeCount: validPnl.length, matureCount: episodes.filter((e: any) => e.marks.matured).length,
        matchedBenchmarkCount: episodes.filter((e: any) => e.marks.excessReturnPct != null).length },
      methodology: "Frozen qualifying long-entry misses; mark from hypothetical fill to post-decision raw closes; matched registered benchmark closes from prior completed session; any later same-symbol paper buy censors; stop/target close proxies are estimates, not fills." });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "missed opportunity ledger failed" }, { status: 500 });
  }
}
