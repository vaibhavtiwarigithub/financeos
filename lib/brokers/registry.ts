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
// active_broker columns don't exist yet (pre-migration) or aren't set. But
// distinguishes a genuinely-missing column (safe, expected, silent fallback)
// from any other error (transient network/auth failure) — those still fall
// back too (an order can't be blocked on a config-read glitch), but are
// logged loudly so a misrouted-broker risk is visible, not silent.
export async function getActiveBroker(supabase: any, market: "us" | "india"): Promise<BrokerAdapter> {
  const col = market === "india" ? "active_broker_india" : "active_broker_us";
  const fallback = market === "india" ? "kite" : "alpaca";
  try {
    const { data, error } = await supabase.from("strategy_config").select(col).maybeSingle();
    if (error) {
      const missingColumn = ["42703", "PGRST204"].includes(String(error.code ?? "")) ||
        /column .* does not exist|could not find the '.*' column/i.test(String(error.message ?? ""));
      if (!missingColumn) {
        console.error(`[broker-registry] strategy_config.${col} read failed (non-schema error) — falling back to ${fallback}:`, error.message);
      }
      return getBroker(fallback)!;
    }
    const id = (data as any)?.[col];
    if (id && !getBroker(id)) {
      console.error(`[broker-registry] strategy_config.${col}='${id}' is not a registered broker — falling back to ${fallback}`);
    }
    return getBroker(id) ?? getBroker(fallback)!;
  } catch (e) {
    console.error(`[broker-registry] unexpected exception reading ${col} — falling back to ${fallback}:`, e);
    return getBroker(fallback)!;
  }
}
