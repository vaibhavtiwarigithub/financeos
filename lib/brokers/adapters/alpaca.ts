import { BrokerAdapter } from "@/lib/brokers/adapter-types";
import { submitAlpacaOrder, getAlpacaOrder, cancelAlpacaOrder, getAlpacaAsset } from "@/lib/brokers/alpaca-orders";
import { capability } from "@/lib/brokers/preflight";
import { createServiceClient } from "@/lib/supabase/service";

export function alpacaAdapter(): BrokerAdapter {
  return {
    id: "alpaca",
    market: "us",
    envs: ["paper", "live"],
    async isConfigured() {
      const sb = createServiceClient();
      const { data } = await sb.from("api_key_vault").select("key_name").in("key_name", ["ALPACA_PAPER_API_KEY", "ALPACA_API_KEY"]);
      return (data && data.length > 0) || !!process.env.ALPACA_PAPER_API_KEY || !!process.env.ALPACA_API_KEY;
    },
    async preflightOrder(o) {
      const r = await getAlpacaAsset(o.symbol, o.env);
      if (!r.ok) return capability(o, { broker: "alpaca", market: "us", source: "alpaca_assets", allowed: false, reasonCode: "asset_lookup_failed", raw: r.error });
      const a = r.data ?? {};
      const active = a.status === "active";
      const tradable = a.tradable === true;
      const fractionable = a.fractionable === true;
      const qtyOk = Number.isInteger(o.qty) || fractionable;
      return capability(o, { broker: "alpaca", market: "us", source: "alpaca_assets", active,
        buyAllowed: tradable, sellAllowed: tradable, fractionalAllowed: fractionable, lotSize: fractionable ? 0.000001 : 1,
        canonicalSymbol: a.symbol ?? null, instrumentId: a.id ?? null, allowed: active && tradable && qtyOk,
        reasonCode: !active ? "asset_inactive" : !tradable ? "asset_not_tradable" : !qtyOk ? "fractional_not_allowed" : null, raw: a });
    },
    submitOrder: (o) => submitAlpacaOrder(o),
    getOrder: (id, env) => getAlpacaOrder(id, env),
    cancelOrder: (id, env) => cancelAlpacaOrder(id, env),
  };
}
