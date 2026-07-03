// Deterministic Quote Adapter — Deno-compatible port of lib/data/quotes.ts

export type QuoteSource = "alpha_vantage" | "price_cache" | "unavailable";

export interface DeterministicQuote {
  symbol: string;
  price: number;
  bid: number | null;
  ask: number | null;
  change: number | null;
  changePct: number | null;
  source: QuoteSource;
  retrievedAt: string;
  stale: boolean;
}

const STALE_THRESHOLD_MS = 15 * 60 * 1000;

function isMarketHours(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const h = et.getHours() + et.getMinutes() / 60;
  return h >= 9.5 && h < 16;
}

function isStale(retrievedAt: string): boolean {
  if (!isMarketHours()) return false;
  return Date.now() - new Date(retrievedAt).getTime() > STALE_THRESHOLD_MS;
}

async function fetchAVQuote(symbol: string, avKey: string): Promise<DeterministicQuote | null> {
  if (!avKey) return null;
  const retrievedAt = new Date().toISOString();
  try {
    const r = await fetch(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${avKey}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const json = await r.json();
    const q = json?.["Global Quote"];
    if (!q || !q["05. price"]) return null;
    const price = parseFloat(q["05. price"]);
    if (price <= 0) return null;
    return {
      symbol, price,
      bid: null, ask: null,
      change: parseFloat(q["09. change"] ?? "0"),
      changePct: parseFloat((q["10. change percent"] ?? "0").replace("%", "")),
      source: "alpha_vantage",
      retrievedAt,
      stale: false,
    };
  } catch { return null; }
}

async function fetchCachedQuote(symbol: string, supabase: any): Promise<DeterministicQuote | null> {
  try {
    const { data } = await supabase
      .from("price_cache")
      .select("close, cached_at, date")
      .eq("symbol", symbol)
      .order("date", { ascending: false })
      .limit(1).single();
    if (!data?.close) return null;
    const retrievedAt = data.cached_at ?? data.date + "T20:00:00Z";
    return {
      symbol, price: Number(data.close),
      bid: null, ask: null, change: null, changePct: null,
      source: "price_cache",
      retrievedAt,
      stale: isStale(retrievedAt),
    };
  } catch { return null; }
}

export async function getQuote(symbol: string, avKey: string, supabase: any): Promise<DeterministicQuote> {
  const unavailable: DeterministicQuote = {
    symbol, price: 0, bid: null, ask: null, change: null, changePct: null,
    source: "unavailable", retrievedAt: new Date().toISOString(), stale: true,
  };
  const avQuote = await fetchAVQuote(symbol, avKey);
  if (avQuote) return avQuote;
  const cached = await fetchCachedQuote(symbol, supabase);
  if (cached) return cached;
  return unavailable;
}

export async function getBatchQuotes(symbols: string[], avKey: string, supabase: any): Promise<Record<string, DeterministicQuote>> {
  const results: Record<string, DeterministicQuote> = {};
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += 5) chunks.push(symbols.slice(i, i + 5));
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async s => { results[s] = await getQuote(s, avKey, supabase); }));
  }
  return results;
}

export function computeFillPrice(quote: DeterministicQuote): number {
  const base = quote.ask ?? quote.price;
  return parseFloat((base * 1.0005).toFixed(4));
}
