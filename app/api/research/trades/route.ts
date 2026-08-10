// GET /api/research/trades?symbol=NVDA
// Returns paper_trades entries for this symbol (not tainted)
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("paper_trades")
    .select("id, symbol, order_side, fill_price, entry_price, exit_price, executed_at, exit_at, closed_at, realized_pnl_pct, fundamental_score, technical_score, sentiment_score, macro_score, analyst_score, direction, rationale, exit_reason, tainted")
    .eq("symbol", symbol)
    .neq("tainted", true)
    .order("executed_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ symbol, trades: data ?? [] });
}
