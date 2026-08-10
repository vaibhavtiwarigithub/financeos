// GET /api/research/fundamentals?symbol=NVDA
// Returns current fundamental snapshot from Finnhub/FMP via fetchUsOverview
import { NextRequest, NextResponse } from "next/server";
import { fetchUsOverview } from "@/lib/data/fundamentals";
import { avCachedFetch } from "@/lib/av-cache";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const avKey = process.env.ALPHA_VANTAGE_API_KEY ?? "";
  const avFallback = async () => {
    if (!avKey) return {};
    const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${avKey}`;
    return (await avCachedFetch(`OVERVIEW:${symbol}`, url, 8000, undefined, 7)) ?? {};
  };
  const { overview, source } = await fetchUsOverview(symbol, avFallback);
  return NextResponse.json({ symbol, overview, source });
}
