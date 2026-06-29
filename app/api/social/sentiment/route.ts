import { NextRequest, NextResponse } from "next/server";
import { fetchSocialSentiment } from "@/lib/social-sentiment";

export const dynamic = "force-dynamic";

// GET /api/social/sentiment?symbol=AAPL
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) {
    return NextResponse.json({ error: "symbol query param required" }, { status: 400 });
  }

  try {
    const sentiment = await fetchSocialSentiment(symbol.toUpperCase());
    return NextResponse.json(sentiment);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
