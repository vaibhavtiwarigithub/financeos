import { BrokerAdapter, BrokerOrderResult, BrokerOrderState } from "@/lib/brokers/adapter-types";
import { placeEquityOrder, kiteGet, kiteDelete, getKiteCreds, getAccessToken } from "@/lib/kite";

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
      return {
        ok: true,
        status: STATUS_MAP[latest.status] ?? "submitted",
        filledQty: latest.filled_quantity != null ? Number(latest.filled_quantity) : undefined,
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
