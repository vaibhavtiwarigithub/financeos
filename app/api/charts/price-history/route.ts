import { NextRequest, NextResponse } from "next/server";
import { fetchPriceHistory } from "@/lib/chart-data";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase();
  const days = parseInt(req.nextUrl.searchParams.get("days") ?? "90");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const candles = await fetchPriceHistory(symbol, Math.min(days, 365));
  return NextResponse.json({ symbol, candles, fetchedAt: new Date().toISOString() });
}
