// Narrow, budgeted intraday observation path for the leveraged paper sleeve.
// No EOD/cache fetch time is ever promoted to an intraday observation time.
import { providerCachedFetch } from "@/lib/data/provider-fetch";
import type { DeterministicQuote } from "@/lib/data/quotes";

export type LeveragedQuoteSymbol = "SOXL" | "SOXS" | "TQQQ" | "SQQQ" | "SOXX" | "QQQ";
const SYMBOLS = new Set<LeveragedQuoteSymbol>(["SOXL", "SOXS", "TQQQ", "SQQQ", "SOXX", "QQQ"]);
const MAX_AGE_MS = 15 * 60_000;

function positive(value: unknown): number | null {
  if (value == null || typeof value === "boolean" || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function observationTime(value: unknown): number | null {
  const numeric = positive(value);
  if (numeric != null) return numeric > 1e12 ? numeric : numeric * 1000;
  if (typeof value !== "string" || !/\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Only a provider-supplied last-quote time qualifies; candle-open timestamps do not. */
export function parseLeveragedIntradayQuote(
  symbol: LeveragedQuoteSymbol, payload: unknown, now: Date = new Date(),
): DeterministicQuote | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (String(row.symbol ?? "").toUpperCase() !== symbol) return null;
  const price = positive(row.close);
  const observedMs = observationTime(row.last_quote_at ?? row.last_update_at);
  if (price == null || observedMs == null) return null;
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (kind: string) => dateParts.find((item) => item.type === kind)?.value;
  const session = `${part("year")}-${part("month")}-${part("day")}`;
  if (row.datetime !== session) return null;
  const age = now.getTime() - observedMs;
  // Fail closed on delayed, future, or malformed observations. A fresh fetch of
  // yesterday's close is not an executable quote for a 3x ETF.
  if (age < 0 || age > MAX_AGE_MS) return null;
  const previousClose = positive(row.previous_close);
  const change = previousClose == null ? null : price - previousClose;
  return {
    symbol, price, bid: null, ask: null,
    change, changePct: change == null ? null : (change / previousClose!) * 100,
    source: "twelvedata", retrievedAt: now.toISOString(), observedAt: new Date(observedMs).toISOString(), stale: false,
    dayLow: positive(row.low), dayHigh: positive(row.high),
  };
}

export async function getLeveragedIntradayQuote(symbol: LeveragedQuoteSymbol): Promise<DeterministicQuote> {
  if (!SYMBOLS.has(symbol)) throw new Error("symbol outside leveraged quote allowlist");
  const unavailable: DeterministicQuote = {
    symbol, price: 0, bid: null, ask: null, change: null, changePct: null,
    source: "unavailable", retrievedAt: new Date().toISOString(), stale: true,
  };
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return unavailable;
  // forceRefresh is essential: the generic provider cache is day-granular.
  // Budget reservation still happens before every external request. Any stale
  // fallback is rejected by parseLeveragedIntradayQuote's source-time test.
  // The daily interval carries the session high/low needed by paper monitoring;
  // last_quote_at (not the daily candle's timestamp) supplies freshness.
  const url = `https://api.twelvedata.com/quote?symbol=${symbol}&interval=1day&apikey=${encodeURIComponent(key)}`;
  try {
    const payload = await providerCachedFetch("twelvedata", `TD_INTRADAY_QUOTE:${symbol}`, url, {
      forceRefresh: true, maxStaleAgeDays: 0, timeoutMs: 8000,
      isThrottled: (value) => !value || value.status === "error" || !value.close || !value.last_quote_at,
    });
    return parseLeveragedIntradayQuote(symbol, payload) ?? unavailable;
  } catch {
    return unavailable;
  }
}
