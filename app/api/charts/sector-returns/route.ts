import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const SECTORS = [
  { symbol: "XLK", name: "Technology" },
  { symbol: "XLF", name: "Financials" },
  { symbol: "XLE", name: "Energy" },
  { symbol: "XLV", name: "Healthcare" },
  { symbol: "XLI", name: "Industrials" },
  { symbol: "XLY", name: "Consumer Disc." },
  { symbol: "XLC", name: "Comm. Services" },
  { symbol: "XLP", name: "Consumer Staples" },
  { symbol: "XLU", name: "Utilities" },
  { symbol: "XLRE", name: "Real Estate" },
  { symbol: "XLB", name: "Materials" },
];

const SYMBOLS = SECTORS.map(s => s.symbol);

export async function GET(req: NextRequest) {
  const days = Math.min(parseInt(req.nextUrl.searchParams.get("days") ?? "90"), 365);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const supabase = createServiceClient();

  // Single batch query for all 11 ETFs
  const { data: rows, error } = await supabase
    .from("price_cache")
    .select("symbol, date, close")
    .in("symbol", SYMBOLS)
    .gte("date", cutoff)
    .order("symbol")
    .order("date", { ascending: true });

  if (error || !rows || rows.length === 0) {
    // Cache is cold — return empty with flag so UI can show helpful message
    return NextResponse.json({ sectors: [], stale: true, message: "Price cache empty — will populate after next agent run" });
  }

  // Group by symbol
  const bySymbol: Record<string, { date: string; close: number }[]> = {};
  for (const row of rows) {
    if (!bySymbol[row.symbol]) bySymbol[row.symbol] = [];
    bySymbol[row.symbol].push({ date: row.date, close: Number(row.close) });
  }

  const results = SECTORS.map(s => {
    const candles = bySymbol[s.symbol] ?? [];
    if (candles.length < 2) return { symbol: s.symbol, name: s.name, returnPct: null, candles: 0 };
    const first = candles[0].close;
    const last = candles[candles.length - 1].close;
    return {
      symbol: s.symbol,
      name: s.name,
      returnPct: ((last - first) / first) * 100,
      latestClose: last,
      candles: candles.length,
    };
  });

  return NextResponse.json({ sectors: results, stale: false, days, cutoff });
}
