import { BrokerAdapter } from "@/lib/brokers/adapter-types";
import { submitAlpacaOrder, getAlpacaOrder, cancelAlpacaOrder } from "@/lib/brokers/alpaca-orders";
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
    submitOrder: (o) => submitAlpacaOrder(o),
    getOrder: (id, env) => getAlpacaOrder(id, env),
    cancelOrder: (id, env) => cancelAlpacaOrder(id, env),
  };
}
