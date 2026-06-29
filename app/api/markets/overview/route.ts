import { NextResponse } from "next/server";

export const revalidate = 300; // 5-minute Next.js cache

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
  DIA: "Dow Jones",
  VIXY: "VIX Proxy (VIXY)",
};

const SECTOR_META: Record<string, string> = {
  XLK: "Technology",
  XLF: "Financials",
  XLE: "Energy",
  XLV: "Healthcare",
  XLI: "Industrials",
  XLY: "Cons. Discretionary",
  XLP: "Cons. Staples",
  XLRE: "Real Estate",
  XLU: "Utilities",
  XLB: "Materials",
  XLC: "Comm. Services",
};

const ALL_SYMBOLS = [...Object.keys(INDEX_META), ...Object.keys(SECTOR_META)];

interface MassivePrevAgg {
  o?: number; // open
  c?: number; // close
  h?: number; // high
  l?: number; // low
  v?: number; // volume
  vw?: number; // volume-weighted avg price
  t?: number; // unix ms timestamp
}

interface MassivePrevResponse {
  results?: MassivePrevAgg[];
  status?: string;
  ticker?: string;
}

async function fetchPrevClose(
  symbol: string,
  apiKey: string
): Promise<{ symbol: string; price: number; change: number; changePct: number }> {
  const url = `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      return { symbol, price: 0, change: 0, changePct: 0 };
    }
    const data: MassivePrevResponse = await res.json();
    const agg = data.results?.[0];
    if (!agg || agg.c == null || agg.o == null) {
      return { symbol, price: 0, change: 0, changePct: 0 };
    }
    const price = agg.c;
    const change = agg.c - agg.o;
    const changePct = (change / agg.o) * 100;
    return {
      symbol,
      price: Math.round(price * 100) / 100,
      change: Math.round(change * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
    };
  } catch {
    return { symbol, price: 0, change: 0, changePct: 0 };
  }
}

// In-memory cache as secondary layer (supplements Next.js revalidate)
let cache: { data: MarketOverview; ts: number } | null = null;
const MEM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function GET() {
  // Serve from in-memory cache if fresh
  if (cache && Date.now() - cache.ts < MEM_CACHE_TTL_MS) {
    return NextResponse.json(cache.data);
  }

  const apiKey = process.env.MASSIVE_API_KEY;
  if (!apiKey) {
    // Return zero-filled skeleton — no API key configured
    const empty = (meta: Record<string, string>) =>
      Object.entries(meta).map(([symbol, name]) => ({
        symbol,
        name,
        price: 0,
        change: 0,
        changePct: 0,
      }));
    return NextResponse.json({
      indices: empty(INDEX_META),
      sectors: empty(SECTOR_META),
      fetchedAt: null,
      stale: true,
    });
  }

  // Fetch all symbols in parallel
  const results = await Promise.all(
    ALL_SYMBOLS.map((sym) => fetchPrevClose(sym, apiKey))
  );

  const quoteMap = new Map(results.map((r) => [r.symbol, r]));

  const indices: IndexQuote[] = Object.entries(INDEX_META).map(
    ([symbol, name]) => {
      const q = quoteMap.get(symbol) ?? { price: 0, change: 0, changePct: 0 };
      return { symbol, name, price: q.price, change: q.change, changePct: q.changePct };
    }
  );

  const sectors: SectorQuote[] = Object.entries(SECTOR_META).map(
    ([symbol, name]) => {
      const q = quoteMap.get(symbol) ?? { price: 0, change: 0, changePct: 0 };
      return { symbol, name, price: q.price, change: q.change, changePct: q.changePct };
    }
  );

  const overview: MarketOverview = {
    indices,
    sectors,
    fetchedAt: new Date().toISOString(),
  };

  cache = { data: overview, ts: Date.now() };
  return NextResponse.json(overview);
}
