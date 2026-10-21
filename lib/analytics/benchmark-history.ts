import type { LevelPoint } from "./benchmark-alpha";
import { benchmarkSymbolFor } from "@/lib/data/benchmark-registry";
import { fetchAllRows } from "@/lib/supabase/paginate";

/** Read all pages in a total order; a provider backfill can exceed one page. */
export async function loadBenchmarkHistory(svc: any, benchmarkId: string, componentSymbol?: string, window?: { from: string; through: string }): Promise<LevelPoint[]> {
  const levels: LevelPoint[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    let query = svc.from("benchmark_price_observations")
      .select("date, close, component_symbol")
      .eq("benchmark_id", benchmarkId).eq("source_status", "ok")
    if (componentSymbol) query = query.eq("component_symbol", componentSymbol);
    if (window) query = query.gte("date", window.from).lte("date", window.through);
    const { data, error } = await query
      .order("date", { ascending: true }).order("component_symbol", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`benchmark history read failed: ${error.message}`);
    const rows = data ?? [];
    levels.push(...rows.map((row: any) => ({ date: String(row.date).slice(0, 10),
      level: row.close == null ? null : Number(row.close) })));
    if (rows.length < pageSize) return levels;
  }
}

/** Stored research reference only: US SPY cache; India exact NIFTY index
 * observations already collected by the benchmark system. Never fetches a
 * provider or substitutes an ETF, portfolio NAV, or another enabled benchmark.
 */
export async function loadStoredResearchBenchmark(svc: any, market: "us" | "india", from: string, through: string) {
  const symbol = benchmarkSymbolFor(market, "research");
  if (market === "us") {
    const rows: any[] = await fetchAllRows((start, end) => svc.from("price_cache").select("date,close")
      .eq("symbol", symbol).gte("date", from).lte("date", through).order("date").range(start, end), "Stored US research benchmark");
    return rows.map((r) => ({ date: String(r.date).slice(0, 10), close: r.close == null ? null : Number(r.close) }));
  }
  const configs: any[] = await fetchAllRows((start, end) => svc.from("benchmarks").select("id,symbol,provider_symbol,currency")
    .eq("market", market).eq("enabled", true).eq("symbol", symbol).order("id").range(start, end), "Stored India research benchmark identity");
  if (configs.length !== 1 || configs[0].currency !== "INR" || configs[0].provider_symbol !== symbol) {
    throw new Error("Exact stored India research benchmark identity unavailable");
  }
  const levels = await loadBenchmarkHistory(svc, configs[0].id, symbol, { from, through });
  return levels.map((r) => ({ date: r.date, close: r.level }));
}
