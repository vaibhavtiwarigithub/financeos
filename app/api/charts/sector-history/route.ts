import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const SYMBOLS = ["XLK","XLF","XLE","XLV","XLI","XLY","XLC","XLP","XLU","XLRE","XLB"];

export async function GET(req: NextRequest) {
  const days = Math.min(parseInt(req.nextUrl.searchParams.get("days") ?? "90"), 3650);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const supabase = createServiceClient();
  const { data: rows, error } = await supabase
    .from("price_cache")
    .select("symbol, date, close")
    .in("symbol", SYMBOLS)
    .gte("date", cutoff)
    .order("symbol")
    .order("date", { ascending: true });

  if (error || !rows || rows.length === 0) {
    return NextResponse.json({ series: {}, stale: true });
  }

  const series: Record<string, { time: string; value: number }[]> = {};
  for (const row of rows) {
    if (!series[row.symbol]) series[row.symbol] = [];
    series[row.symbol].push({ time: row.date, value: Number(row.close) });
  }

  return NextResponse.json({ series, stale: false, days, cutoff });
}
