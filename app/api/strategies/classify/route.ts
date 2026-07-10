import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

interface StrategyTemplate {
  id: string;
  name: string;
  description: string | null;
  rules: Record<string, unknown>;
}

interface SymbolData {
  rsi: number;
  priceAboveMA50: boolean | null;
  priceAboveMA200: boolean | null;
  fcfYield: number;
  roe: number;
  insiderBuying: boolean;
  pctFrom52wHigh: number;
  revenueGrowthYOY: number;
  peg: number | null;
  peRatio: number | null;
}

function scoreStrategy(rules: Record<string, unknown>, data: SymbolData): number {
  let score = 0, total = 0;
  if (rules.rsi_min !== undefined) { total += 20; if (data.rsi >= (rules.rsi_min as number)) score += 20; }
  if (rules.rsi_max !== undefined) { total += 20; if (data.rsi <= (rules.rsi_max as number)) score += 20; }
  if (rules.above_ma50 !== undefined) { total += 15; if (data.priceAboveMA50 === true) score += 15; }
  if (rules.above_ma200 !== undefined) { total += 15; if (data.priceAboveMA200 === true) score += 15; }
  if (rules.peg_max !== undefined) { total += 15; if (data.peg !== null && data.peg <= (rules.peg_max as number)) score += 15; }
  if (rules.pe_vs_sector === "below_median") { total += 15; if (data.peRatio !== null && data.peRatio < 20) score += 15; }
  if (rules.fcf_yield_min !== undefined) { total += 10; if (data.fcfYield >= (rules.fcf_yield_min as number)) score += 10; }
  if (rules.roe_min !== undefined) { total += 15; if (data.roe >= (rules.roe_min as number)) score += 15; }
  if (rules.insider_buying) { total += 10; if (data.insiderBuying) score += 10; }
  if (rules.near_52w_high) { total += 10; if (data.pctFrom52wHigh <= 10) score += 10; }
  if (rules.pct_from_52w_high_max !== undefined) { total += 10; if (data.pctFrom52wHigh <= (rules.pct_from_52w_high_max as number)) score += 10; }
  if (rules.revenue_accel) { total += 15; if (data.revenueGrowthYOY > 10) score += 15; }
  if (rules.rev_growth_min !== undefined) { total += 15; if (data.revenueGrowthYOY >= (rules.rev_growth_min as number)) score += 15; }
  return total > 0 ? Math.round((score / total) * 100) : 0;
}

async function fetchSymbolData(symbol: string, apiKey: string): Promise<SymbolData> {
  const [overviewRes, rsiRes] = await Promise.all([
    fetch(`https://www.alphavantage.co/query?function=COMPANY_OVERVIEW&symbol=${symbol}&apikey=${apiKey}`),
    fetch(`https://www.alphavantage.co/query?function=RSI&symbol=${symbol}&interval=daily&time_period=14&series_type=close&apikey=${apiKey}`),
  ]);

  const overview = await overviewRes.json() as Record<string, string>;
  const rsiData = await rsiRes.json() as Record<string, unknown>;

  // Parse RSI
  let rsi = 50;
  const rsiSeries = rsiData["Technical Analysis: RSI"] as Record<string, Record<string, string>> | undefined;
  if (rsiSeries) {
    const latestDate = Object.keys(rsiSeries)[0];
    if (latestDate) rsi = parseFloat(rsiSeries[latestDate]["RSI"] ?? "50") || 50;
  }

  // Parse overview fields
  const high52w = parseFloat(overview["52WeekHigh"] ?? "0") || 0;
  const ma50 = parseFloat(overview["50DayMovingAverage"] ?? "0") || 0;
  const ma200 = parseFloat(overview["200DayMovingAverage"] ?? "0") || 0;
  const price = ma50 > 0 ? ma50 : 0; // Use 50DMA as price proxy
  const peRatio = parseFloat(overview["PERatio"] ?? "0") || null;
  const pegRatio = parseFloat(overview["PEGRatio"] ?? "0") || null;
  const roe = parseFloat(overview["ReturnOnEquityTTM"] ?? "0") * 100 || 0;
  const opCashflow = parseFloat(overview["OperatingCashflowTTM"] ?? "0") || 0;
  const marketCap = parseFloat(overview["MarketCapitalization"] ?? "0") || 0;
  const fcfYield = marketCap > 0 ? (opCashflow / marketCap) * 100 : 0;
  const revenueGrowthYOY = parseFloat(overview["QuarterlyRevenueGrowthYOY"] ?? "0") * 100 || 0;
  const pctFrom52wHigh = high52w > 0 && price > 0 ? ((high52w - price) / high52w) * 100 : 100;

  return {
    rsi,
    priceAboveMA50: ma200 > 0 && price > 0 ? price >= ma50 : null,
    priceAboveMA200: ma200 > 0 && price > 0 ? price >= ma200 : null,
    fcfYield,
    roe,
    insiderBuying: false,
    pctFrom52wHigh,
    revenueGrowthYOY,
    peg: pegRatio,
    peRatio,
  };
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  try {
    const body = await req.json() as { symbols?: string[] };
    const symbols: string[] = (body.symbols ?? []).map((s: string) => s.trim().toUpperCase()).filter(Boolean);

    if (!symbols.length) {
      return NextResponse.json({ error: "symbols required" }, { status: 400 });
    }

    const svc = createServiceClient();
    const { data: templates, error: tErr } = await svc.from("strategy_templates").select("*");
    if (tErr || !templates) {
      return NextResponse.json({ error: "Failed to load strategy templates" }, { status: 500 });
    }

    const strategies = templates as StrategyTemplate[];
    const apiKey = process.env.ALPHA_VANTAGE_API_KEY ?? "";
    const useMock = !apiKey;

    const results: Array<{ symbol: string; classifications: Array<{ strategy: string; fit_score: number }> }> = [];

    for (const symbol of symbols) {
      let symbolData: SymbolData;
      if (useMock) {
        symbolData = { rsi: 55, priceAboveMA50: true, priceAboveMA200: true, fcfYield: 3, roe: 12, insiderBuying: false, pctFrom52wHigh: 8, revenueGrowthYOY: 12, peg: 1.5, peRatio: 18 };
      } else {
        try {
          symbolData = await fetchSymbolData(symbol, apiKey);
        } catch {
          symbolData = { rsi: 50, priceAboveMA50: null, priceAboveMA200: null, fcfYield: 0, roe: 0, insiderBuying: false, pctFrom52wHigh: 50, revenueGrowthYOY: 0, peg: null, peRatio: null };
        }
      }

      const classifications: Array<{ strategy: string; fit_score: number }> = [];

      for (const strategy of strategies) {
        const fitScore = useMock ? 50 : scoreStrategy(strategy.rules, symbolData);
        classifications.push({ strategy: strategy.name, fit_score: fitScore });

        // Upsert to DB
        await svc.from("strategy_classifications").upsert(
          { symbol, strategy_id: strategy.id, fit_score: fitScore, matched_at: new Date().toISOString() },
          { onConflict: "symbol,strategy_id" }
        );
      }

      results.push({ symbol, classifications });
    }

    return NextResponse.json({ results });
  } catch (err) {
    console.error("classify error", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
