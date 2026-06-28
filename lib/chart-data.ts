import { execClaude, parseClaudeOutput } from "@/lib/claude-exec";

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

// 1-hour cache per symbol
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000;

export async function fetchPriceHistory(symbol: string, days = 90): Promise<Candle[]> {
  const key = `${symbol}:${days}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

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
    cache.set(key, { data: candles, ts: Date.now() });
    return candles;
  } catch {
    return [];
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
