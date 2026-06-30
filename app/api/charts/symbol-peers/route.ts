import { NextRequest, NextResponse } from "next/server";

export const revalidate = 21600; // 6h cache

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase().trim();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const avKey = process.env.ALPHA_VANTAGE_API_KEY;
  const fdKey = process.env.FINANCIAL_DATASETS_API_KEY;
  if (!avKey || !fdKey) return NextResponse.json({ error: "API keys missing" }, { status: 500 });

  // 1. Get sector + industry from Alpha Vantage COMPANY_OVERVIEW
  const ovRes = await fetch(
    `https://www.alphavantage.co/query?function=COMPANY_OVERVIEW&symbol=${symbol}&apikey=${avKey}`,
    { next: { revalidate: 21600 } }
  );
  const ov = await ovRes.json();
  const sector = ov.Sector as string | undefined;
  const industry = ov.Industry as string | undefined;
  if (!sector) return NextResponse.json({ error: "Could not identify sector", peers: [] });

  // 2. Get peers from FinancialDatasets screen_stocks by sector
  const screenUrl = `https://api.financialdatasets.ai/financial-metrics/search/?sector=${encodeURIComponent(sector)}&limit=20&apikey=${fdKey}`;
  let peerSymbols: string[] = [];
  try {
    const screenRes = await fetch(screenUrl, { next: { revalidate: 21600 } });
    const screenData = await screenRes.json();
    const items = screenData.results ?? screenData.data ?? [];
    peerSymbols = items
      .map((i: any) => i.ticker ?? i.symbol)
      .filter((s: string) => s && s !== symbol)
      .slice(0, 7);
  } catch {}

  // Fallback to hardcoded peers per major sector if screen failed
  if (peerSymbols.length === 0) {
    const FALLBACK: Record<string, string[]> = {
      "Technology": ["AAPL", "MSFT", "GOOGL", "NVDA", "META", "AMZN"],
      "Financials": ["JPM", "BAC", "WFC", "GS", "MS", "C"],
      "Health Care": ["JNJ", "UNH", "PFE", "ABBV", "MRK", "LLY"],
      "Consumer Discretionary": ["AMZN", "TSLA", "HD", "MCD", "NKE", "SBUX"],
      "Energy": ["XOM", "CVX", "COP", "SLB", "EOG", "OXY"],
      "Industrials": ["CAT", "BA", "HON", "UNP", "GE", "MMM"],
      "Communication Services": ["GOOGL", "META", "NFLX", "DIS", "CMCSA", "T"],
      "Materials": ["LIN", "APD", "SHW", "FCX", "NEM", "DOW"],
      "Utilities": ["NEE", "DUK", "SO", "AEP", "EXC", "XEL"],
      "Real Estate": ["AMT", "PLD", "CCI", "EQIX", "PSA", "DLR"],
      "Consumer Staples": ["PG", "KO", "PEP", "WMT", "COST", "CL"],
    };
    peerSymbols = (FALLBACK[sector] ?? []).filter(s => s !== symbol).slice(0, 6);
  }

  // Always include the target symbol first
  const allSymbols = [symbol, ...peerSymbols.filter(s => s !== symbol)].slice(0, 8);

  // 3. Fetch COMPANY_OVERVIEW for each peer in parallel
  const peerData = await Promise.allSettled(
    allSymbols.map(async (sym) => {
      const r = await fetch(
        `https://www.alphavantage.co/query?function=COMPANY_OVERVIEW&symbol=${sym}&apikey=${avKey}`,
        { next: { revalidate: 21600 } }
      );
      const d = await r.json();
      if (!d.Symbol) return null;
      return {
        symbol: sym,
        name: d.Name as string,
        sector: d.Sector as string,
        marketCap: d.MarketCapitalization ? Number(d.MarketCapitalization) : null,
        peRatio: d.PERatio !== "None" ? Number(d.PERatio) : null,
        forwardPE: d.ForwardPE !== "None" ? Number(d.ForwardPE) : null,
        eps: d.EPS !== "None" ? Number(d.EPS) : null,
        revenueGrowth: d.RevenueGrowthYOY !== "None" && d.RevenueGrowthYOY ? Number(d.RevenueGrowthYOY) * 100 : null,
        grossMargin: d.GrossProfitTTM && d.RevenueTTM ? (Number(d.GrossProfitTTM) / Number(d.RevenueTTM) * 100) : null,
        beta: d.Beta !== "None" ? Number(d.Beta) : null,
        dividendYield: d.DividendYield !== "None" ? Number(d.DividendYield) * 100 : null,
        analystTarget: d.AnalystTargetPrice !== "None" ? Number(d.AnalystTargetPrice) : null,
        week52High: d["52WeekHigh"] !== "None" ? Number(d["52WeekHigh"]) : null,
        week52Low: d["52WeekLow"] !== "None" ? Number(d["52WeekLow"]) : null,
      };
    })
  );

  const peers = peerData
    .map(r => r.status === "fulfilled" ? r.value : null)
    .filter(Boolean);

  return NextResponse.json({ symbol, sector, industry, peers });
}
