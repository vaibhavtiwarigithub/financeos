// Broker adapter registry. Adding a future broker (e.g. E*TRADE) = one new
// file in lib/brokers/adapters/ implementing BrokerAdapter + one entry here.
// Zero route/UI changes required beyond that. Keys always go in the Vault —
// never hardcoded, never entered in Settings.

import { BrokerAdapter } from "@/lib/brokers/adapter-types";
import { alpacaAdapter } from "@/lib/brokers/adapters/alpaca";
import { kiteAdapter } from "@/lib/brokers/adapters/kite";

const ADAPTERS: Record<string, () => BrokerAdapter> = {
  alpaca: alpacaAdapter,
  kite: kiteAdapter,
};

export function getBroker(id: string): BrokerAdapter | null {
  const factory = ADAPTERS[id];
  return factory ? factory() : null;
}

export function listBrokers(market: "us" | "india"): BrokerAdapter[] {
  return Object.values(ADAPTERS).map(f => f()).filter(a => a.market === market);
}

// Resilient: falls back to alpaca (us) / kite (india) if strategy_config's
// active_broker columns don't exist yet (pre-migration) or aren't set.
export async function getActiveBroker(supabase: any, market: "us" | "india"): Promise<BrokerAdapter> {
  const col = market === "india" ? "active_broker_india" : "active_broker_us";
  const fallback = market === "india" ? "kite" : "alpaca";
  try {
    const { data } = await supabase.from("strategy_config").select(col).maybeSingle();
    const id = (data as any)?.[col] ?? fallback;
    return getBroker(id) ?? getBroker(fallback)!;
  } catch {
    return getBroker(fallback)!;
  }
}
