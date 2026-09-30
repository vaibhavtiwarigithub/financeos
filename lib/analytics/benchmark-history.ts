import type { LevelPoint } from "./benchmark-alpha";

/** Read all pages in a total order; a provider backfill can exceed one page. */
export async function loadBenchmarkHistory(svc: any, benchmarkId: string, componentSymbol?: string): Promise<LevelPoint[]> {
  const levels: LevelPoint[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    let query = svc.from("benchmark_price_observations")
      .select("date, close, component_symbol")
      .eq("benchmark_id", benchmarkId).eq("source_status", "ok")
    if (componentSymbol) query = query.eq("component_symbol", componentSymbol);
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
