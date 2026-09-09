import { BrokerAdapter, BrokerOrderResult, BrokerOrderState } from "@/lib/brokers/adapter-types";
import { placeEquityOrder, kiteGet, kiteDelete, getKiteCreds, getAccessToken, getKiteEquityInstrument } from "@/lib/kite";
import { capability } from "@/lib/brokers/preflight";

// Kite has no paper/sandbox environment — live only.
const STATUS_MAP: Record<string, BrokerOrderState["status"]> = {
  OPEN: "submitted", "OPEN PENDING": "submitted", TRIGGER_PENDING: "submitted",
  COMPLETE: "filled", CANCELLED: "canceled", REJECTED: "rejected", EXPIRED: "expired",
};

export function kiteAdapter(): BrokerAdapter {
  return {
    id: "kite",
    market: "india",
    envs: ["live"],
    async isConfigured() {
      try {
        const { apiKey, apiSecret } = await getKiteCreds();
        if (!apiKey || !apiSecret) return false;
        // Kite's access token expires daily — keys present isn't enough to
        // place a live order, the session must actually be live today.
        const { fresh } = await getAccessToken();
        return fresh;
      } catch { return false; }
    },
    async preflightOrder(o) {
      if (o.env !== "live") return capability(o, { broker: "kite", market: "india", source: "kite_instruments", allowed: false, reasonCode: "unsupported_environment" });
      const instrument = await getKiteEquityInstrument(o.symbol);
      if (!instrument.ok) return capability(o, { broker: "kite", market: "india", source: "kite_instruments", allowed: false, reasonCode: "instrument_not_found", raw: instrument.error });
      const bare = String(instrument.data.symbol).toUpperCase();
      const exchange = String(instrument.data.exchange);
      const quoteKey = `${exchange}:${bare}`;
      const quote = await kiteGet(`/quote?i=${encodeURIComponent(quoteKey)}`);
      const quotePresent = quote.ok && !!quote.data?.[quoteKey];
      const lotSize = Number(instrument.data.lotSize);
      const qtyOk = Number.isInteger(o.qty) && lotSize > 0 && o.qty % lotSize === 0;
      const tick = Number(instrument.data.tickSize);
      const tickOk = o.type !== "limit" || o.limitPrice == null || (Number.isFinite(tick) && Math.abs(o.limitPrice / tick - Math.round(o.limitPrice / tick)) < 1e-6);
      return capability(o, { broker: "kite", market: "india", source: "kite_instruments+quote", active: true,
        buyAllowed: quotePresent, sellAllowed: quotePresent, canonicalSymbol: `${bare}.${exchange === "BSE" ? "BO" : "NS"}`, instrumentId: String(instrument.data.instrumentToken),
        fractionalAllowed: false, lotSize, tickSize: tick, allowed: quotePresent && qtyOk && tickOk,
        reasonCode: !quotePresent ? "quote_key_missing" : !qtyOk ? "invalid_lot_size" : !tickOk ? "invalid_tick_size" : null,
        raw: { instrument: instrument.data, quotePresent } });
    },
    async submitOrder(o): Promise<BrokerOrderResult> {
      if (o.env !== "live") return { ok: false, error: "Kite supports live orders only (no paper env)" };
      const res = await placeEquityOrder({
        tradingsymbol: o.symbol,
        transaction_type: o.side === "buy" ? "BUY" : "SELL",
        quantity: o.qty,
        order_type: o.type === "limit" ? "LIMIT" : "MARKET",
        price: o.limitPrice,
      });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, brokerOrderId: res.data?.order_id, raw: res.data };
    },
    async getOrder(brokerOrderId, env): Promise<BrokerOrderState> {
      // env intentionally unused today (Kite is live-only), but the parameter
      // must be accepted — TS structural typing silently allows a function
      // with fewer params to satisfy BrokerAdapter, so a caller passing env
      // would have it silently dropped with no compile error until this.
      void env;
      const res = await kiteGet(`/orders/${brokerOrderId}`);
      if (!res.ok) return { ok: false, error: res.error };
      const history = Array.isArray(res.data) ? res.data : [];
      const latest = history[history.length - 1];
      if (!latest) return { ok: false, error: "No order history found" };
      const filledQty = latest.filled_quantity != null ? Number(latest.filled_quantity) : undefined;
      const mapped = STATUS_MAP[latest.status] ?? "submitted";
      return {
        ok: true,
        status: mapped === "submitted" && Number(filledQty) > 0 ? "partially_filled" : mapped,
        filledQty,
        avgFillPrice: latest.average_price != null ? Number(latest.average_price) : undefined,
        raw: latest,
      };
    },
    async cancelOrder(brokerOrderId, env) {
      void env;
      const res = await kiteDelete(`/orders/regular/${brokerOrderId}`);
      return { ok: res.ok, error: res.error };
    },
  };
}
