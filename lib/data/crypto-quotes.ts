import type { Candle } from "@/lib/data/technicals";
import { avCachedFetch } from "@/lib/av-cache";

export type CryptoCandleSource = "coinbase_exchange" | "kraken" | "alpha_vantage" | "unavailable";
export type CryptoCandleResult = { candles: Candle[]; source: CryptoCandleSource; attempted: CryptoCandleSource[] };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const KRAKEN_PAIR: Record<string, string> = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD" };

function coinFor(symbol: string): string {
  const coin = symbol.trim().toUpperCase().replace(/(?:-|\/)?USD$/, "");
  return /^[A-Z0-9]{2,15}$/.test(coin) ? coin : "";
}

function dateFromEpochSeconds(value: unknown): string | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 10) : null;
}

function validCandle(value: Partial<Candle>): value is Candle {
  const fields = [value.open, value.high, value.low, value.close, value.volume];
  return typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
    && fields.every((field) => Number.isFinite(field) && Number(field) >= 0)
    && Number(value.open) > 0 && Number(value.high) > 0 && Number(value.low) > 0 && Number(value.close) > 0
    && Number(value.low) <= Math.min(Number(value.open), Number(value.close), Number(value.high))
    && Number(value.high) >= Math.max(Number(value.open), Number(value.close), Number(value.low));
}

/** Normalizes, deduplicates and orders candles oldest-first before technical work. */
export function normalizeCryptoCandles(values: Array<Partial<Candle>>): Candle[] {
  const byDate = new Map<string, Candle>();
  for (const value of values) if (validCandle(value)) byDate.set(value.date, value);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function parseCoinbaseDailyCandles(payload: unknown): Candle[] {
  if (!Array.isArray(payload)) return [];
  // Coinbase Exchange: [ time, low, high, open, close, volume ].
  return normalizeCryptoCandles(payload.map((row): Partial<Candle> => {
    if (!Array.isArray(row)) return {};
    return { date: dateFromEpochSeconds(row[0]) ?? undefined, low: Number(row[1]), high: Number(row[2]), open: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) };
  }));
}

export function parseKrakenDailyCandles(payload: unknown): Candle[] {
  const result = (payload as any)?.result;
  if (!result || typeof result !== "object") return [];
  const rows = Object.entries(result).find(([key, value]) => key !== "last" && Array.isArray(value))?.[1];
  if (!Array.isArray(rows)) return [];
  // Kraken OHLC: [ time, open, high, low, close, vwap, volume, count ].
  return normalizeCryptoCandles(rows.map((row: unknown): Partial<Candle> => {
    if (!Array.isArray(row)) return {};
    return { date: dateFromEpochSeconds(row[0]) ?? undefined, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[6]) };
  }));
}

async function fetchJson(url: string, fetcher: FetchLike): Promise<unknown> {
  const response = await fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function coinbaseCandles(coin: string, fetcher: FetchLike): Promise<Candle[]> {
  // Coinbase products use BASE-USD. Do not keep a three-coin allowlist here:
  // the broker's point-in-time inventory is the universe authority. A product
  // Coinbase does not offer simply yields its normal provider error and lets
  // the independent fallback run.
  if (!coin) return [];
  return parseCoinbaseDailyCandles(await fetchJson(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400`, fetcher));
}

async function krakenCandles(coin: string, fetcher: FetchLike): Promise<Candle[]> {
  const pair = KRAKEN_PAIR[coin];
  return pair ? parseKrakenDailyCandles(await fetchJson(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1440`, fetcher)) : [];
}

async function alphaVantageCandles(coin: string, avKey: string): Promise<Candle[]> {
  if (!avKey) return [];
  const json = await avCachedFetch(`AV_CRYPTO_DAILY:${coin}`, `https://www.alphavantage.co/query?function=DIGITAL_CURRENCY_DAILY&symbol=${coin}&market=USD&apikey=${avKey}`);
  const series = json?.["Time Series (Digital Currency Daily)"];
  if (!series || typeof series !== "object") return [];
  return normalizeCryptoCandles(Object.entries(series as Record<string, Record<string, string>>).map(([date, d]) => ({
    date, open: Number(d["1. open"] ?? 0), high: Number(d["2. high"] ?? 0), low: Number(d["3. low"] ?? 0), close: Number(d["4. close"] ?? 0), volume: Number(d["5. volume"] ?? 0),
  })));
}

/**
 * Independent public daily candles for crypto research. Broker quotes are never
 * substituted here: they are execution evidence, not a historical data source.
 * Alpha Vantage is a last-resort compatibility fallback, so normal crypto
 * research cannot consume the shared equity quota.
 */
export async function fetchCryptoCandles(symbol: string, avKey = "", fetcher: FetchLike = fetch): Promise<CryptoCandleResult> {
  const coin = coinFor(symbol);
  const attempted: CryptoCandleSource[] = [];
  for (const [source, load] of [
    ["coinbase_exchange", () => coinbaseCandles(coin, fetcher)],
    ["kraken", () => krakenCandles(coin, fetcher)],
    ["alpha_vantage", () => alphaVantageCandles(coin, avKey)],
  ] as const) {
    if (source === "alpha_vantage" && !avKey) continue;
    attempted.push(source);
    try {
      const candles = await load();
      // A short/malformed payload must not block the independent fallback.
      if (candles.length >= 51) return { candles, source, attempted };
    } catch { /* source failure is contained; next provider is independent */ }
  }
  return { candles: [], source: "unavailable", attempted };
}
