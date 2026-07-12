import { createServiceClient } from "@/lib/supabase/service";
import { fetchUsCandles } from "@/lib/data/candles";
import { avCachedFetch } from "@/lib/av-cache";

export interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CacheEntry {
  data: Candle[];
  ts: number;
}

// In-process cache (backup layer so we never hit subprocess twice per hour)
const memCache = new Map<string, CacheEntry>();
const MEM_TTL_MS = 60 * 60 * 1000;

function isFresh(latestDate: string): boolean {
  // Consider cache fresh if most recent entry is within 3 calendar days
  // (covers weekends + market close lag)
  return new Date(latestDate).getTime() >= Date.now() - 3 * 24 * 60 * 60 * 1000;
}

export async function fetchPriceHistory(symbol: string, days = 90): Promise<Candle[]> {
  const key = `${symbol}:${days}`;

  // 1. In-process memory cache
  const mem = memCache.get(key);
  if (mem && Date.now() - mem.ts < MEM_TTL_MS) return mem.data;

  // 2. Supabase price_cache (fast — DB query)
  try {
    const supabase = createServiceClient();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const { data: rows } = await supabase
      .from("price_cache")
      .select("date, open, high, low, close, volume")
      .eq("symbol", symbol)
      .gte("date", cutoff)
      .order("date", { ascending: true });

    if (rows && rows.length > 0 && isFresh(rows[rows.length - 1].date)) {
      const candles: Candle[] = rows.map((r: any) => ({
        date: r.date,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      }));
      memCache.set(key, { data: candles, ts: Date.now() });
      return candles;
    }
  } catch {
    // DB unavailable — fall through to subprocess
  }

  // 3. Deterministic REST fallback (no subprocess). Massive → EODHD → Twelve
  // Data → Alpha Vantage TIME_SERIES_DAILY, via the shared candle resolver.
  try {
    const { candles: resolved } = await fetchUsCandles(
      symbol,
      () => fetchAvDailyCandles(symbol),
      1, // accept any usable bars; charts render whatever the sources return
    );
    // Keep only the most recent `days` bars (resolver returns oldest-first).
    const candles: Candle[] = resolved.slice(-days).map(c => ({
      date: c.date,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
    }));

    // Write to DB so next request is fast
    if (candles.length > 0) {
      writePriceCacheRows(symbol, candles).catch(() => {});
    }

    memCache.set(key, { data: candles, ts: Date.now() });
    return candles;
  } catch {
    return [];
  }
}

// Alpha Vantage TIME_SERIES_DAILY → Candle[] (oldest first). Day-cached via
// av-cache; the final fallback tier behind Massive/EODHD/Twelve Data.
async function fetchAvDailyCandles(symbol: string): Promise<Candle[]> {
  const avKey = process.env.ALPHA_VANTAGE_API_KEY ?? "";
  if (!avKey) return [];
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=full&apikey=${avKey}`;
  const json = await avCachedFetch(`TIME_SERIES_DAILY:${symbol}`, url, 8000);
  const series = json?.["Time Series (Daily)"];
  if (!series || typeof series !== "object") return [];
  return Object.entries(series)
    .map(([date, v]: [string, any]) => ({
      date,
      open: parseFloat(v["1. open"]),
      high: parseFloat(v["2. high"]),
      low: parseFloat(v["3. low"]),
      close: parseFloat(v["4. close"]),
      volume: parseFloat(v["5. volume"] ?? "0"),
    }))
    .filter(c => Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Write candles to Supabase price_cache (upsert)
async function writePriceCacheRows(symbol: string, candles: Candle[]): Promise<void> {
  const supabase = createServiceClient();
  const rows = candles.map(c => ({
    symbol,
    date: c.date,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    cached_at: new Date().toISOString(),
  }));
  for (let i = 0; i < rows.length; i += 200) {
    await supabase.from("price_cache").upsert(rows.slice(i, i + 200), { onConflict: "symbol,date" });
  }
}

// Pre-warm price_cache for a list of symbols via deterministic REST candles.
// Called at end of daily cron — populates DB so all chart requests are instant
// for the day. Fetches per-symbol through the shared candle resolver
// (Massive → EODHD → Twelve Data → Alpha Vantage), no subprocess/LLM.
export async function prewarmPriceCache(symbols: string[], _supabase: any): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  // Modest concurrency so a large watchlist doesn't burst provider budgets.
  for (let i = 0; i < symbols.length; i += 4) {
    const batch = symbols.slice(i, i + 4);
    await Promise.all(batch.map(async (sym) => {
      try {
        const { candles: resolved } = await fetchUsCandles(
          sym,
          () => fetchAvDailyCandles(sym),
          1,
        );
        if (resolved.length === 0) return;
        await writePriceCacheRows(sym, resolved.map(c => ({
          date: c.date,
          open: Number(c.open) || 0,
          high: Number(c.high) || 0,
          low: Number(c.low) || 0,
          close: Number(c.close) || 0,
          volume: Number(c.volume) || 0,
        })));
        // Clear mem cache so next request picks up fresh DB rows
        for (const k of memCache.keys()) {
          if (k.startsWith(sym + ":")) memCache.delete(k);
        }
        ok++;
      } catch { /* non-critical */ }
    }));
  }

  return { ok, failed: symbols.length - ok };
}

// Normalize candles to % return from first close
export function normalizeToReturn(candles: Candle[]): Array<{ date: string; pct: number }> {
  if (candles.length === 0) return [];
  const base = candles[0].close;
  return candles.map(c => ({
    date: c.date,
    pct: parseFloat((((c.close - base) / base) * 100).toFixed(3)),
  }));
}
