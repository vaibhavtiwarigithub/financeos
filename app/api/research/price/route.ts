// GET /api/research/price?symbol=NVDA&days=365
// Returns OHLCV candles from fetchPriceHistory
import { NextRequest, NextResponse } from "next/server";
import { fetchPriceHistory } from "@/lib/chart-data";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase();
  const days = parseInt(req.nextUrl.searchParams.get("days") ?? "365");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const validDays = Math.min(Math.max(days, 30), 2000);
  const candles = await fetchPriceHistory(symbol, validDays);
  return NextResponse.json({ symbol, candles });
}
