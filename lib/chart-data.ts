import { execClaude, parseClaudeOutput } from "@/lib/claude-exec";
import { createServiceClient } from "@/lib/supabase/service";

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
      const candles: Candle[] = rows.map(r => ({
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

  // 3. Subprocess fallback (slow, ~90s cold start)
  const prompt = `Use the TIME_SERIES_DAILY tool from Alpha Vantage to fetch daily price data for ${symbol}.

After calling the tool, output ONLY a JSON object with this structure:
{
  "candles": [
    { "date": "2026-01-15", "open": 123.4, "high": 125.0, "low": 122.0, "close": 124.5, "volume": 12345678 },
    ...
  ]
}

Rules:
- Include the most recent ${days} trading days
- Dates in YYYY-MM-DD format, sorted OLDEST first
- All price/volume values must be numbers (not strings)
- Output ONLY the JSON object, no markdown, no prose
- If data is unavailable, output: {"candles": []}`;

  try {
    const stdout = await execClaude(prompt, 90000);
    const raw = parseClaudeOutput(stdout);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");
    const parsed = JSON.parse(jsonMatch[0]);
    const candles: Candle[] = Array.isArray(parsed.candles) ? parsed.candles : [];

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

// Pre-warm price_cache for a list of symbols using a single Robinhood historicals call.
// Called at end of daily cron — populates DB so all chart requests are instant for the day.
export async function prewarmPriceCache(symbols: string[], supabase: any): Promise<{ ok: number; failed: number }> {
  const prompt = `Call get_equity_historicals with symbols [${symbols.map(s => `"${s}"`).join(", ")}], interval "day", span "year".

Return ONLY a JSON object (no markdown, no prose):
{
  "symbols": {
    "AAPL": [{"date":"2026-01-01","open":1,"high":1,"low":1,"close":1,"volume":1}, ...],
    "NVDA": [...]
  }
}

Include up to 90 trading days per symbol, sorted OLDEST first. All values numbers.`;

  try {
    const stdout = await execClaude(prompt, 180000);
    const raw = parseClaudeOutput(stdout);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: 0, failed: symbols.length };

    const parsed = JSON.parse(jsonMatch[0]);
    const symbolsData: Record<string, any[]> = parsed.symbols ?? {};

    let ok = 0;
    for (const [sym, candles] of Object.entries(symbolsData)) {
      if (!Array.isArray(candles) || candles.length === 0) continue;
      try {
        await writePriceCacheRows(sym, candles.map(c => ({
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
    }

    return { ok, failed: symbols.length - ok };
  } catch {
    return { ok: 0, failed: symbols.length };
  }
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
