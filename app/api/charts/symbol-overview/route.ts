import { NextRequest, NextResponse } from "next/server";
export const revalidate = 3600; // 1h cache

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase().trim();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "no key" }, { status: 500 });

  const res = await fetch(
    `https://www.alphavantage.co/query?function=COMPANY_OVERVIEW&symbol=${symbol}&apikey=${apiKey}`,
    { next: { revalidate: 3600 } }
  );
  const data = await res.json();

  // Detect Alpha Vantage rate limit responses
  if (data.Note || data.Information) {
    return NextResponse.json(
      { error: "rate_limited", message: data.Note ?? data.Information },
      { status: 429 }
    );
  }

  return NextResponse.json({
    name: data.Name,
    exchange: data.Exchange,
    sector: data.Sector,
    industry: data.Industry,
    marketCap: data.MarketCapitalization ? Number(data.MarketCapitalization) : null,
    peRatio: data.PERatio !== "None" ? Number(data.PERatio) : null,
    eps: data.EPS !== "None" ? Number(data.EPS) : null,
    revenueGrowth: data.RevenueGrowthYOY !== "None" && data.RevenueGrowthYOY ? Number(data.RevenueGrowthYOY) : null,
    grossMargin: data.GrossProfitTTM && data.RevenueTTM ?
      (Number(data.GrossProfitTTM) / Number(data.RevenueTTM) * 100) : null,
    dividendYield: data.DividendYield !== "None" ? Number(data.DividendYield) * 100 : null,
    beta: data.Beta !== "None" ? Number(data.Beta) : null,
    week52High: data["52WeekHigh"] !== "None" ? Number(data["52WeekHigh"]) : null,
    week52Low: data["52WeekLow"] !== "None" ? Number(data["52WeekLow"]) : null,
    analystTarget: data.AnalystTargetPrice !== "None" ? Number(data.AnalystTargetPrice) : null,
    forwardPE: data.ForwardPE !== "None" ? Number(data.ForwardPE) : null,
    psRatio: data.PriceToSalesRatioTTM !== "None" ? Number(data.PriceToSalesRatioTTM) : null,
    pbRatio: data.PriceToBookRatio !== "None" ? Number(data.PriceToBookRatio) : null,
    description: data.Description,
  });
}
