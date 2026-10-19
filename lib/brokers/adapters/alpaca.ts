import { BrokerAdapter } from "@/lib/brokers/adapter-types";
import { submitAlpacaOrder, getAlpacaOrder, cancelAlpacaOrder, getAlpacaAsset } from "@/lib/brokers/alpaca-orders";
import { isAlpacaConfigured } from "@/lib/brokers/alpaca-credentials";
import { capability } from "@/lib/brokers/preflight";

export function alpacaAdapter(): BrokerAdapter {
  return {
    id: "alpaca",
    market: "us",
    envs: ["paper", "live"],
    isConfigured: isAlpacaConfigured,
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
