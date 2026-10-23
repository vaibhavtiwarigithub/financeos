import { getAlpacaCredentials } from "@/lib/brokers/alpaca-credentials";
import { providerCachedFetch } from "@/lib/data/provider-fetch";
import type { Candle } from "@/lib/data/technicals";

const MARKET_DATA_BASE = "https://data.alpaca.markets/v2/stocks";

export type IntradayBar = Candle & { at: string; vwap?: number };

/** Strict five-minute event bars. Never relabel request time as bar time. */
export function parseAlpacaIntradayBars(payload: unknown): IntradayBar[] {
  const root = payload as any;
  if (!Array.isArray(root?.bars)) return [];
  const seen = new Set<string>();
  const bars: IntradayBar[] = [];
  for (const row of root.bars) {
    if (typeof row?.t !== "string" || !Number.isFinite(Date.parse(row.t)) || seen.has(row.t)) return [];
    if (![row.o, row.h, row.l, row.c, row.v].every(v => typeof v === "number" && Number.isFinite(v))
      || Math.min(row.o, row.h, row.l, row.c) <= 0 || row.v < 0
      || row.h < Math.max(row.o, row.c, row.l) || row.l > Math.min(row.o, row.c, row.h)) return [];
    const date = sessionDate(row.t);
    if (!date) return [];
    seen.add(row.t);
    bars.push({ at: row.t, date, open: row.o, high: row.h, low: row.l, close: row.c, volume: row.v,
      ...(typeof row.vw === "number" && Number.isFinite(row.vw) && row.vw > 0 ? { vwap: row.vw } : {}) });
  }
  return bars.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export async function fetchAlpacaIexIntradayBars(symbol: string, now = new Date()): Promise<IntradayBar[]> {
  if (!["SOXL", "SOXS", "TQQQ", "SQQQ", "SOXX", "QQQ"].includes(symbol)) return [];
  const credentials = await getAlpacaCredentials("paper") ?? await getAlpacaCredentials("live");
  if (!credentials) return [];
  const start = new Date(now.getTime() - 7 * 86_400_000);
  const url = `${MARKET_DATA_BASE}/${symbol}/bars?timeframe=5Min&start=${start.toISOString()}&end=${now.toISOString()}&limit=1000&adjustment=all&feed=iex&sort=desc`;
  const payload = await providerCachedFetch("alpaca", `ALPACA_IEX_5MIN:${symbol}:${Math.floor(now.getTime() / 300000)}`, url, {
    timeoutMs: 8000, maxAgeDays: 0, maxStaleAgeDays: 0,
    headers: { "APCA-API-KEY-ID": credentials.key, "APCA-API-SECRET-KEY": credentials.secret },
    // Descending newest 1,000 bars is a bounded warmup, not an exhaustive backfill.
    isThrottled: value => !Array.isArray(value?.bars),
  });
  return parseAlpacaIntradayBars(payload);
}

function sessionDate(timestamp: unknown): string | null {
  if (typeof timestamp !== "string") return null;
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(parsed);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function finitePositive(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseAlpacaDailyBars(payload: unknown): Candle[] {
  const bars = (payload as { bars?: unknown } | null)?.bars;
  if (!Array.isArray(bars)) return [];
  const parsed: Candle[] = [];
  for (const row of bars) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const date = sessionDate(item.t);
    const open = finitePositive(item.o), high = finitePositive(item.h);
    const low = finitePositive(item.l), close = finitePositive(item.c);
    const volume = typeof item.v === "number" ? item.v : Number(item.v);
    if (!date || open == null || high == null || low == null || close == null || !Number.isFinite(volume) || volume < 0) continue;
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) continue;
    parsed.push({ date, open, high, low, close, volume });
  }
  return parsed.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Alpaca Basic equities feed, explicitly pinned to IEX. This is a research
 * fallback, not a consolidated US tape. Credentials are never returned/logged.
 */
export async function fetchAlpacaIexDailyCandles(
  symbol: string,
  days = 160,
): Promise<{ candles: Candle[]; unavailableReason?: "auth_missing" | "provider_error" | "genuine_no_data" }> {
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(normalized)) return { candles: [], unavailableReason: "genuine_no_data" };
  const credentials = await getAlpacaCredentials("paper") ?? await getAlpacaCredentials("live");
  if (!credentials) return { candles: [], unavailableReason: "auth_missing" };

  const end = new Date();
  const start = new Date(end.getTime() - days * 2 * 86_400_000);
  const url = `${MARKET_DATA_BASE}/${encodeURIComponent(normalized)}/bars?timeframe=1Day&start=${start.toISOString()}&end=${end.toISOString()}&limit=1000&adjustment=all&feed=iex&sort=asc`;
  const payload = await providerCachedFetch("alpaca", `ALPACA_IEX_DAILY:${normalized}:${days}`, url, {
    timeoutMs: 10_000,
    headers: {
      "APCA-API-KEY-ID": credentials.key,
      "APCA-API-SECRET-KEY": credentials.secret,
    },
    maxAgeDays: 0,
    maxStaleAgeDays: 0,
    isThrottled: (value) => !value || !Array.isArray(value.bars),
  });
  if (payload == null) return { candles: [], unavailableReason: "provider_error" };
  const candles = parseAlpacaDailyBars(payload);
  return candles.length ? { candles } : { candles, unavailableReason: "genuine_no_data" };
}
