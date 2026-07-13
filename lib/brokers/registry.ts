// Broker adapter registry. Adding a future broker (e.g. E*TRADE) = one new
// file in lib/brokers/adapters/ implementing BrokerAdapter + one entry here.
// Zero route/UI changes required beyond that. Keys always go in the Vault —
// never hardcoded, never entered in Settings.

import { BrokerAdapter } from "@/lib/brokers/adapter-types";
import { alpacaAdapter } from "@/lib/brokers/adapters/alpaca";
import { kiteAdapter } from "@/lib/brokers/adapters/kite";
import { robinhoodMcpAdapter } from "@/lib/brokers/adapters/robinhood-mcp";
import { robinhoodAdapter } from "@/lib/brokers/adapters/robinhood";
import { webullAdapter } from "@/lib/brokers/adapters/webull";

const ADAPTERS: Record<string, () => BrokerAdapter> = {
  alpaca: alpacaAdapter,
  kite: kiteAdapter,
  // US live via Robinhood MCP — needs a live MCP session, so it does NOT work in
  // Vercel serverless route/cron handlers.
  robinhood_mcp: robinhoodMcpAdapter,
  // US live via direct Robinhood REST — SERVERLESS-CAPABLE. Set
  // strategy_config.active_broker_us='robinhood' to route live US orders here.
  robinhood: robinhoodAdapter,
  // US live via Webull MCP (Phase 2) — SHIPPED INERT. isConfigured() is FALSE
  // until the owner reconnects Webull with order scopes, adds+sets
  // strategy_config.webull_orders_enabled, allowlists a broker_accounts
  // (broker='webull', role='trading') row, and flips cfg.orderCapable=true. The
  // order path is UNTESTED against a live account — see lib/brokers/adapters/
  // webull.ts. Registered here only so the Gateway can find it once enabled; it
  // is NOT set as any active_broker and is in NO cron/automated flow.
  webull: webullAdapter,
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
// STRICT resolver for the ORDER path — never falls back. A transient config
// read error or an unset/unknown broker ABORTS the order rather than silently
// routing it to the default broker (which could be a different live account).
// Use getActiveBroker (below) only for non-order UI display.
export async function getActiveBrokerForOrder(supabase: any, market: "us" | "india"): Promise<{ ok: true; broker: BrokerAdapter } | { ok: false; error: string }> {
  const col = market === "india" ? "active_broker_india" : "active_broker_us";
  const { data, error } = await supabase.from("strategy_config").select(col).maybeSingle();
  if (error) return { ok: false, error: `Could not read ${col}: ${error.message}` };
  const id = (data as any)?.[col];
  if (!id) return { ok: false, error: `No active broker configured for ${market}` };
  const broker = getBroker(id);
  if (!broker) return { ok: false, error: `Unknown active broker '${id}'` };
  return { ok: true, broker };
}

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
