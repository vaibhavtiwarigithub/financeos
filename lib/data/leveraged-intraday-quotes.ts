// Narrow, budgeted intraday observation path for the leveraged paper sleeve.
// No EOD/cache fetch time is ever promoted to an intraday observation time.
import { providerCachedFetch } from "@/lib/data/provider-fetch";
import type { DeterministicQuote } from "@/lib/data/quotes";
import { readRobinhoodLeveragedQuoteRows } from "@/lib/robinhood-mcp";

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

/** Broker bid and ask each have their own venue event time. Fetch time never substitutes. */
export function parseRobinhoodLeveragedQuote(
  symbol: LeveragedQuoteSymbol, payload: unknown, now: Date = new Date(),
): DeterministicQuote | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (String(row.symbol ?? "").toUpperCase() !== symbol) return null;
  const bid = positive(row.bid_price);
  const ask = positive(row.ask_price);
  const bidTime = observationTime(row.venue_bid_time);
  const askTime = observationTime(row.venue_ask_time);
  if (bid == null || ask == null || ask < bid || bidTime == null || askTime == null) return null;
  const nowMs = now.getTime();
  if ([bidTime, askTime].some((time) => time > nowMs || nowMs - time > MAX_AGE_MS)) return null;
  // A crossed-time spread can be fictional even when each side is individually fresh.
  if (Math.abs(bidTime - askTime) > 60_000) return null;
  const mid = (bid + ask) / 2;
  const previousClose = positive(row.adjusted_previous_close ?? row.previous_close);
  return {
    symbol, price: mid, bid, ask,
    change: previousClose == null ? null : mid - previousClose,
    changePct: previousClose == null ? null : ((mid - previousClose) / previousClose) * 100,
    source: "robinhood_mcp", retrievedAt: now.toISOString(),
    observedAt: new Date(Math.min(bidTime, askTime)).toISOString(), stale: false,
    bidObservedAt: new Date(bidTime).toISOString(), askObservedAt: new Date(askTime).toISOString(),
    dayLow: null, dayHigh: null,
  };
}

/** Only a validated broker bid/ask may satisfy the leveraged live/shadow spread contract. */
export async function getLeveragedExecutableQuote(symbol: LeveragedQuoteSymbol): Promise<DeterministicQuote | null> {
  return (await getLeveragedExecutableQuotes([symbol])).get(symbol) ?? null;
}

export async function getLeveragedExecutableQuotes(symbols: LeveragedQuoteSymbol[]): Promise<Map<LeveragedQuoteSymbol, DeterministicQuote>> {
  if (!symbols.length || symbols.some((symbol) => !SYMBOLS.has(symbol))) throw new Error("symbol outside leveraged quote allowlist");
  const parsed = new Map<LeveragedQuoteSymbol, DeterministicQuote>();
  try {
    const rows = await readRobinhoodLeveragedQuoteRows(symbols);
    const now = new Date();
    for (const symbol of symbols) {
      const quote = parseRobinhoodLeveragedQuote(symbol, rows.find((row) => String(row.symbol ?? "").toUpperCase() === symbol), now);
      if (quote) parsed.set(symbol, quote);
    }
  } catch {
    // Broker disconnected or quote tool unavailable: never infer bid/ask from a last price.
  }
  return parsed;
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
  if (!key) return await getLeveragedExecutableQuote(symbol) ?? unavailable;
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
    const quote = parseLeveragedIntradayQuote(symbol, payload);
    if (quote) return quote;
  } catch {
    // An exhausted research feed must not hide an independently fresh broker quote.
  }
  return await getLeveragedExecutableQuote(symbol) ?? unavailable;
}
