import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

async function fetchInsiderTransactions(symbol: string, apiKey: string) {
  try {
    const res = await fetch(
      `https://www.alphavantage.co/query?function=INSIDER_TRANSACTIONS&symbol=${symbol}&apikey=${apiKey}`,
      { next: { revalidate: 3600 } }
    );
    const data = await res.json();
    if (data["Note"] || data["Information"] || data["Error Message"]) return [];
    const txns = data.data ?? [];
    return txns.slice(0, 10).map((t: any) => ({
      symbol,
      insiderName: t.insider_name ?? t.name ?? "Unknown",
      relationship: t.relationship ?? "",
      transactionType: t.transaction_type ?? t.action ?? "UNKNOWN",
      shares: parseInt(t.shares ?? "0") || 0,
      sharePrice: parseFloat(t.share_price ?? "0") || 0,
      value: parseInt(t.value ?? "0") || 0,
      date: t.transaction_date ?? t.date ?? "",
    }));
  } catch { return []; }
}

export async function GET(req: NextRequest) {
  const svc = createServiceClient();
  const avKey = process.env.ALPHA_VANTAGE_API_KEY;

  // Get top-scored signals from last 30 days
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data: signals } = await svc
    .from("agent_signals")
    .select("symbol, direction, analyst_score, insider_score, technical_score, fundamental_score, sentiment_score, macro_score, created_at, asset_class")
    .gte("created_at", since)
    .order("insider_score", { ascending: false })
    .limit(50);

  // Get pending trade queue
  const { data: tradeQueue } = await svc
    .from("trade_queue")
    .select("*")
    .in("status", ["pending_approval", "approved"])
    .order("created_at", { ascending: false })
    .limit(20);

  // Get options signals (unusual activity) from last 7 days
  const optionsSince = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data: optionsSignals } = await svc
    .from("agent_signals")
    .select("symbol, analyst_score, insider_score, technical_score, direction, created_at, asset_class")
    .gte("created_at", optionsSince)
    .gte("insider_score", 60)
    .order("insider_score", { ascending: false })
    .limit(15);

  // Fetch insider transactions for top 3 high-insider-score symbols (conserve AV quota)
  let insiderData: any[] = [];
  if (avKey) {
    const topSymbols = [...new Set(
      (signals ?? [])
        .filter((s: any) => (s.insider_score ?? 0) >= 50 && s.asset_class !== "etf" && s.asset_class !== "metal")
        .slice(0, 3)
        .map((s: any) => s.symbol)
    )];

    const insiderResults = await Promise.all(
      topSymbols.map((sym: any) => fetchInsiderTransactions(sym as string, avKey))
    );
    insiderData = insiderResults
      .flat()
      .filter((t: any) => t.transactionType?.includes("P") || t.transactionType === "Buy" || t.value > 50000)
      .sort((a: any, b: any) => b.value - a.value);
  }

  // Build signal buckets by asset class
  const byClass: Record<string, any[]> = {};
  for (const s of signals ?? []) {
    const cls = (s as any).asset_class ?? "us_equity";
    if (!byClass[cls]) byClass[cls] = [];
    byClass[cls].push(s);
  }

  return NextResponse.json({
    signals: signals ?? [],
    byClass,
    optionsUnusual: optionsSignals ?? [],
    insiderTransactions: insiderData,
    tradeQueue: tradeQueue ?? [],
  });
}
