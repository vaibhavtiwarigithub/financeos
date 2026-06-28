import { NextResponse } from "next/server";
import { execClaude, parseClaudeOutput } from "@/lib/claude-exec";

export const dynamic = "force-dynamic";

// Cache in-memory for 5 minutes
let cache: { data: MarketOverview; ts: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface IndexQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
}

export interface SectorQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
}

export interface MarketOverview {
  indices: IndexQuote[];
  sectors: SectorQuote[];
  fetchedAt: string;
}

const INDEX_META: Record<string, string> = {
  SPY: "S&P 500",
  QQQ: "Nasdaq 100",
  IWM: "Russell 2000",
  VIX: "VIX",
};

const SECTOR_META: Record<string, string> = {
  XLK: "Technology",
  XLF: "Financials",
  XLE: "Energy",
  XLV: "Health Care",
  XLI: "Industrials",
  XLY: "Consumer Disc.",
  XLP: "Consumer Staples",
  XLU: "Utilities",
  XLRE: "Real Estate",
  XLB: "Materials",
  XLC: "Comm. Services",
};

const ALL_SYMBOLS = [...Object.keys(INDEX_META), ...Object.keys(SECTOR_META)];

export async function GET() {
  // Serve from cache if still fresh
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json(cache.data);
  }

  const prompt = `Use the get_stock_prices tool from FinancialDatasets to fetch current price data for these symbols: ${ALL_SYMBOLS.join(", ")}.

After fetching, output ONLY a JSON object (no markdown, no prose) with this exact structure:
{
  "quotes": [
    { "symbol": "SPY", "price": 123.45, "change": 1.23, "changePct": 0.85 },
    ...one entry per symbol...
  ]
}

Rules:
- price = current/latest price (number)
- change = price change today in dollars (number, negative if down)
- changePct = percentage change today (number, negative if down, e.g. -1.2 means -1.2%)
- If a symbol has no data, still include it with price: 0, change: 0, changePct: 0
- Output ONLY the JSON object, nothing else`;

  let overview: MarketOverview;

  try {
    const stdout = await execClaude(prompt, 90000);
    const raw = parseClaudeOutput(stdout);

    // Extract the JSON object
    const jsonMatches = raw.match(/\{[\s\S]*\}/g) ?? [];
    let parsed: { quotes: Array<{ symbol: string; price: number; change: number; changePct: number }> } | null = null;

    for (let i = jsonMatches.length - 1; i >= 0; i--) {
      try {
        const candidate = JSON.parse(jsonMatches[i]);
        if (Array.isArray(candidate.quotes)) {
          parsed = candidate;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!parsed) {
      throw new Error(`Failed to parse Claude output: ${raw.slice(0, 400)}`);
    }

    const quoteMap = new Map(parsed.quotes.map(q => [q.symbol, q]));

    const indices: IndexQuote[] = Object.entries(INDEX_META).map(([symbol, name]) => {
      const q = quoteMap.get(symbol) ?? { price: 0, change: 0, changePct: 0 };
      return { symbol, name, price: q.price, change: q.change, changePct: q.changePct };
    });

    const sectors: SectorQuote[] = Object.entries(SECTOR_META).map(([symbol, name]) => {
      const q = quoteMap.get(symbol) ?? { price: 0, change: 0, changePct: 0 };
      return { symbol, name, price: q.price, change: q.change, changePct: q.changePct };
    });

    overview = { indices, sectors, fetchedAt: new Date().toISOString() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  cache = { data: overview, ts: Date.now() };
  return NextResponse.json(overview);
}
