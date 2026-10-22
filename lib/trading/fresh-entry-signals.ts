import { fetchAllRows } from "@/lib/supabase/paginate";

/** Select newest assessment BEFORE filtering. A downgrade must retire old highs. */
export function latestQualifiedEntrySignals<T extends {
  id: string; symbol: string; market: string | null; created_at: string;
  direction: string | null; analyst_score: number | null; signal_breakdown?: any; rank_rejected?: boolean | null; status?: string | null;
}>(rows: T[], market: string, threshold: number): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    if (row.market !== market) continue;
    const previous = latest.get(row.symbol);
    if (!previous || row.created_at > previous.created_at || (row.created_at === previous.created_at && row.id > previous.id)) latest.set(row.symbol, row);
  }
  return [...latest.values()].filter(row => row.direction === "long" && row.analyst_score != null
    && row.analyst_score >= threshold && row.rank_rejected !== true && row.status !== "rank_rejected"
    && row.signal_breakdown?.trade_plan?.status === "candidate")
    .sort((a, b) => Number(b.analyst_score) - Number(a.analyst_score) || a.symbol.localeCompare(b.symbol));
}

export async function loadFreshEntrySignals(svc: any, market: "us" | "india", threshold: number): Promise<any[]> {
  const { data: cutoff, error } = await svc.rpc("market_trading_day_start", { p_market: market });
  if (error || typeof cutoff !== "string" || !Number.isFinite(Date.parse(cutoff))) throw new Error(`Cannot certify ${market} signal freshness`);
  const rows = await fetchAllRows<any>((from, to) => svc.from("agent_signals")
    .select("id,symbol,market,direction,analyst_score,conviction,score_source,rationale,created_at,signal_breakdown,rank_rejected,status")
    .eq("market", market).eq("score_source", "deterministic_v1").eq("session_validated", true)
    .gte("created_at", cutoff).order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to),
  `${market} fresh live entry assessments`);
  return latestQualifiedEntrySignals(rows, market, threshold);
}
