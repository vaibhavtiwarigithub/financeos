import type { FieldProvenance, ProviderAdapter, ProviderRequest, ProviderResult } from "@/lib/evidence/contracts";
import { readRobinhoodEquityQuoteRows } from "@/lib/robinhood-mcp";
import { hasForbiddenKeys, isFiniteNumber, isPlainObject } from "@/lib/evidence/adapters/shared";

const PROVIDER = "robinhood_mcp" as const;
const MAX_AGE_MS = 15 * 60_000;

export interface CanonicalBrokerQuote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  bidObservedAt: string;
  askObservedAt: string;
  source: typeof PROVIDER;
}

function positive(value: unknown): number | null {
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : NaN;
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function normalizeQuote(symbol: string, row: Record<string, unknown>, now: number): CanonicalBrokerQuote | null {
  const rowSymbol = String(row.symbol ?? row.ticker ?? "").toUpperCase();
  if (rowSymbol !== symbol) return null;
  const bid = positive(row.bid_price ?? row.bid);
  const ask = positive(row.ask_price ?? row.ask);
  const bidMs = timestamp(row.venue_bid_time ?? row.bid_time ?? row.bid_timestamp);
  const askMs = timestamp(row.venue_ask_time ?? row.ask_time ?? row.ask_timestamp);
  if (bid == null || ask == null || ask < bid || bidMs == null || askMs == null) return null;
  if ([bidMs, askMs].some((time) => time > now || now - time > MAX_AGE_MS) || Math.abs(bidMs - askMs) > 60_000) return null;
  return {
    symbol, bid, ask, mid: (bid + ask) / 2,
    bidObservedAt: new Date(bidMs).toISOString(),
    askObservedAt: new Date(askMs).toISOString(),
    source: PROVIDER,
  };
}

function validQuote(value: unknown): value is CanonicalBrokerQuote {
  if (!isPlainObject(value) || hasForbiddenKeys(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.symbol === "string" && row.source === PROVIDER &&
    isFiniteNumber(row.bid) && row.bid > 0 && isFiniteNumber(row.ask) && row.ask >= row.bid &&
    isFiniteNumber(row.mid) && row.mid > 0 &&
    typeof row.bidObservedAt === "string" && Number.isFinite(Date.parse(row.bidObservedAt)) &&
    typeof row.askObservedAt === "string" && Number.isFinite(Date.parse(row.askObservedAt));
}

export const robinhoodMcpQuoteAdapter: ProviderAdapter = {
  providerId: PROVIDER,
  intent: "price.quote",
  contractVersion: "robinhood-mcp-equity-l1-v1",
  markets: ["us"],
  pacingOwner: "router",

  async fetch(request: ProviderRequest): Promise<ProviderResult> {
    const symbol = String(request.symbol ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) return { ok: false, unavailableReason: "genuine_no_data" };
    try {
      const rows = await readRobinhoodEquityQuoteRows([symbol]);
      const row = rows.find((item) => String(item.symbol ?? item.ticker ?? "").toUpperCase() === symbol);
      if (!row) return { ok: false, unavailableReason: "genuine_no_data" };
      const quote = normalizeQuote(symbol, row, Date.now());
      return quote ? { ok: true, payload: quote, raw: { symbol, fieldNames: Object.keys(row).sort() } }
        : { ok: false, unavailableReason: "schema_invalid" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return { ok: false, unavailableReason: /not connected/i.test(message) ? "auth_missing" : "provider_error" };
    }
  },

  validate(raw: unknown): ProviderResult {
    return validQuote(raw)
      ? { ok: true, payload: raw }
      : { ok: false, unavailableReason: "schema_invalid" };
  },

  toCanonical(result: ProviderResult): { payload: CanonicalBrokerQuote; provenance: FieldProvenance[] } {
    const quote = result.payload as CanonicalBrokerQuote;
    const retrievedAt = new Date().toISOString();
    return {
      payload: quote,
      provenance: [
        { providerId: PROVIDER, providerField: "bid", basis: "spot", unit: "currency", currency: "USD", observedAt: quote.bidObservedAt, retrievedAt },
        { providerId: PROVIDER, providerField: "ask", basis: "spot", unit: "currency", currency: "USD", observedAt: quote.askObservedAt, retrievedAt },
      ],
    };
  },
};

export const __test = { normalizeQuote, validQuote };
