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

  const prompt = `Call the Robinhood MCP tool get_equity_quotes with symbols: [${ALL_SYMBOLS.map(s => `"${s}"`).join(", ")}]

From the result, for each symbol compute:
- price = pick quote.last_non_reg_trade_price if more recent than quote.last_trade_price, else quote.last_trade_price. Convert string to number.
- change = price - adjusted_previous_close (number, negative if down)
- changePct = (change / adjusted_previous_close) * 100 (number, 2 decimal places)

Output ONLY a JSON object (no markdown, no prose):
{
  "quotes": [
    { "symbol": "SPY", "price": 123.45, "change": 1.23, "changePct": 0.85 },
    ...one entry per symbol...
  ]
}

Rules:
- All values must be numbers (not strings)
- If a symbol is missing from the result, still include it with price: 0, change: 0, changePct: 0
- Output ONLY the JSON object, nothing else`;

  let overview: MarketOverview;

  try {
    const stdout = await execClaude(prompt, 90000);
    const raw = parseClaudeOutput(stdout);

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
      throw new Error(`parse_failed: ${raw.slice(0, 200)}`);
    }

    const quoteMap = new Map(parsed.quotes.map(q => [q.symbol, q]));

    const indices: IndexQuote[] = Object.entries(INDEX_META).map(([symbol, name]) => {
      const q = quoteMap.get(symbol) ?? { price: 0, change: 0, changePct: 0 };
      return { symbol, name, price: Number(q.price) || 0, change: Number(q.change) || 0, changePct: Number(q.changePct) || 0 };
    });

    const sectors: SectorQuote[] = Object.entries(SECTOR_META).map(([symbol, name]) => {
      const q = quoteMap.get(symbol) ?? { price: 0, change: 0, changePct: 0 };
      return { symbol, name, price: Number(q.price) || 0, change: Number(q.change) || 0, changePct: Number(q.changePct) || 0 };
    });

    overview = { indices, sectors, fetchedAt: new Date().toISOString() };
  } catch {
    // Serve stale cache on failure so the UI always gets something
    if (cache) {
      return NextResponse.json({ ...cache.data, stale: true });
    }
    // No cache at all — return zero-filled skeleton so page renders
    const empty = (entries: Record<string, string>) =>
      Object.entries(entries).map(([symbol, name]) => ({ symbol, name, price: 0, change: 0, changePct: 0 }));
    return NextResponse.json({
      indices: empty(INDEX_META),
      sectors: empty(SECTOR_META),
      fetchedAt: null,
      stale: true,
    });
  }

  cache = { data: overview, ts: Date.now() };
  return NextResponse.json(overview);
}
