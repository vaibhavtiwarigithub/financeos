import { fetchAllRows } from "@/lib/supabase/paginate";

/** Shared recency rule. Ranking scores must never choose an older assessment. */
export function latestEntryAssessments<T extends { id: string; symbol: string; created_at: string }>(rows: T[]): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    if (!symbol) throw new Error("Assessment has no symbol; entry cohort cannot be certified");
    const previous = latest.get(symbol);
    if (!previous || row.created_at > previous.created_at || (row.created_at === previous.created_at && row.id > previous.id)) latest.set(symbol, row);
  }
  return [...latest.values()];
}

/** Select newest assessment BEFORE filtering. A downgrade must retire old highs. */
export function latestQualifiedEntrySignals<T extends {
  id: string; symbol: string; market: string | null; created_at: string;
  direction: string | null; analyst_score: number | null; signal_breakdown?: any; rank_rejected?: boolean | null; status?: string | null;
}>(rows: T[], market: string, threshold: number): T[] {
  return latestEntryAssessments(rows.filter(row => row.market === market)).filter(row => row.direction === "long" && row.analyst_score != null
    && row.analyst_score >= threshold && row.rank_rejected !== true && row.status !== "rank_rejected"
    && row.signal_breakdown?.trade_plan?.status === "candidate")
    .sort((a, b) => Number(b.analyst_score) - Number(a.analyst_score) || a.symbol.localeCompare(b.symbol));
}

export async function loadFreshEntrySignals(svc: any, market: "us" | "india", threshold: number): Promise<any[]> {
  const { data: cutoff, error } = await svc.rpc("market_trading_day_start", { p_market: market });
  if (error || typeof cutoff !== "string" || !Number.isFinite(Date.parse(cutoff))) throw new Error(`Cannot certify ${market} signal freshness`);
  const rows = await fetchAllRows<any>((from, to) => svc.from("agent_signals")
    .select("id,symbol,market,asset_class,direction,analyst_score,conviction,score_source,scoring_version,rationale,created_at,signal_breakdown,rank_pct,rank_rejected,status,research_packet_id,mandate_id,stop_loss_pct,take_profit_pct,session_validated,is_holding,source,fundamental_score,technical_score,sentiment_score,macro_score,insider_score")
    .eq("market", market).eq("score_source", "deterministic_v1").eq("session_validated", true)
    .gte("created_at", cutoff).order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to),
  `${market} fresh live entry assessments`);
  return latestQualifiedEntrySignals(rows, market, threshold);
}
