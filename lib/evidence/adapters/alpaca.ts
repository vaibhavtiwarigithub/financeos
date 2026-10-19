import type { FieldProvenance, ProviderAdapter, ProviderCallContext, ProviderRequest, ProviderResult } from "@/lib/evidence/contracts";
import { fetchAlpacaIexDailyCandles } from "@/lib/data/alpaca-market-data";
import { newestBarIsStale } from "@/lib/data/candles";
import type { Candle } from "@/lib/data/technicals";
import { hasForbiddenKeys, isFiniteNumber, isPlainObject } from "@/lib/evidence/adapters/shared";

const PROVIDER = "alpaca" as const;
const MIN_BARS = 60;

export interface AlpacaIexDailyBars {
  bars: Candle[];
  adjusted: true;
  count: number;
  source: typeof PROVIDER;
  providerFeed: "IEX (Alpaca Basic; not consolidated SIP)";
  currency: "USD";
}

function validBar(value: unknown): value is Candle {
  if (!isPlainObject(value) || hasForbiddenKeys(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
    isFiniteNumber(row.open) && row.open > 0 && isFiniteNumber(row.high) && row.high > 0 &&
    isFiniteNumber(row.low) && row.low > 0 && isFiniteNumber(row.close) && row.close > 0 &&
    isFiniteNumber(row.volume) && row.volume >= 0 && row.high >= Math.max(row.open, row.low, row.close) &&
    row.low <= Math.min(row.open, row.high, row.close);
}

function isPayload(value: unknown): value is AlpacaIexDailyBars {
  if (!isPlainObject(value) || hasForbiddenKeys(value)) return false;
  const row = value as Record<string, unknown>;
  return row.source === PROVIDER && row.adjusted === true && row.providerFeed === "IEX (Alpaca Basic; not consolidated SIP)" &&
    row.currency === "USD" && Number.isInteger(row.count) && Array.isArray(row.bars) &&
    row.count === row.bars.length && row.bars.length >= MIN_BARS && row.bars.every(validBar);
}

export const alpacaIexBarsAdapter: ProviderAdapter = {
  providerId: PROVIDER,
  intent: "price.daily_bars",
  contractVersion: "alpaca-iex-adjusted-daily-bars-v1",
  markets: ["us"],
  pacingOwner: "adapter",

  async fetch(request: ProviderRequest, _ctx: ProviderCallContext): Promise<ProviderResult> {
    const symbol = String(request.symbol ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) return { ok: false, unavailableReason: "genuine_no_data" };
    const result = await fetchAlpacaIexDailyCandles(symbol, 160);
    if (result.unavailableReason) return { ok: false, unavailableReason: result.unavailableReason };
    if (result.candles.length < MIN_BARS || newestBarIsStale(result.candles)) {
      return { ok: false, unavailableReason: "genuine_no_data" };
    }
    const payload: AlpacaIexDailyBars = {
      bars: result.candles, adjusted: true, count: result.candles.length, source: PROVIDER,
      providerFeed: "IEX (Alpaca Basic; not consolidated SIP)", currency: "USD",
    };
    return { ok: true, payload, raw: { source: PROVIDER, feed: "iex", count: payload.count } };
  },

  validate(raw: unknown): ProviderResult {
    return isPayload(raw) ? { ok: true, payload: raw } : { ok: false, unavailableReason: "schema_invalid" };
  },

  toCanonical(result: ProviderResult): { payload: AlpacaIexDailyBars; provenance: FieldProvenance[] } {
    const payload = result.payload as AlpacaIexDailyBars;
    const retrievedAt = new Date().toISOString();
    return {
      payload,
      provenance: [{
        providerId: PROVIDER, providerField: "daily_bars_iex_adjusted", basis: "eod",
        unit: "currency", currency: "USD", retrievedAt,
        observedAt: payload.bars.length ? `${payload.bars[payload.bars.length - 1].date}T00:00:00.000Z` : undefined,
      }],
    };
  },
};
