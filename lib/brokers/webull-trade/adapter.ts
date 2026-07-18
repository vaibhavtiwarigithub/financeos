// ============================================================================
// webull_trade — the signed Webull Trading API BrokerAdapter.
// ----------------------------------------------------------------------------
// Registry id: `webull_trade` (distinct from the read-only Cloud MCP `webull`).
// This is the ONLY Webull signed-execution surface. It is DISABLED today at every
// layer and makes NO live/sandbox network call:
//   - isConfigured() fails closed because webull_trade_orders_enabled is absent,
//     there is no allowlisted webull_trade account, and no webull_trade vault
//     credential exists.
//   - submitOrder() re-checks the flag/allowlist/credential/token and refuses
//     before constructing any transport, so nothing reaches the wire.
// The tested money-path surface is the pure modules (signing, gates, token,
// order, lifecycle) exercised against fixtures with an injected transport.
// ============================================================================

import { BrokerAdapter, BrokerOrderResult, BrokerOrderState } from "@/lib/brokers/adapter-types";
import { createServiceClient } from "@/lib/supabase/service";
import {
  countWebullUsTradingAccounts,
  resolveWebullTradingAccount,
  webullTradeOrdersEnabled,
} from "./config";
import { getWebullTradeCredential, supabaseVaultReader } from "./credentials";

// The BrokerAdapter interface carries no stopPrice/clientOrderId/accountId, so the
// generic submit path supports only MARKET/LIMIT entries. The GTC STOP_LOSS
// disaster floor is placed via the typed lifecycle (lib/brokers/webull-trade/
// lifecycle.ts) from the future protective-order controller, never this method.
export function webullTradeAdapter(): BrokerAdapter {
  return {
    id: "webull_trade",
    market: "us",
    envs: ["live"], // signed Webull trading is live money; sandbox is internal to credentials

    // Fail CLOSED. Returns true ONLY when the flag is on, exactly one Webull US
    // trading account is allowlisted, AND a prod credential exists in the vault.
    // All three are false today, so this is permanently false until the owner
    // provisions them after entitlement + sandbox proof.
    async isConfigured() {
      try {
        const svc = createServiceClient();
        if (!(await webullTradeOrdersEnabled(svc))) return false;
        if ((await countWebullUsTradingAccounts(svc)) !== 1) return false;
        const cred = await getWebullTradeCredential(supabaseVaultReader(svc), "prod");
        return cred.ok;
      } catch {
        return false;
      }
    },

    async submitOrder(o): Promise<BrokerOrderResult> {
      // Defense in depth — the Execution Gateway validates upstream; the adapter
      // re-checks its own boundary and refuses before any wire access.
      if (o.env !== "live") return { ok: false, error: "webull_trade is live-only" };
      if (!Number.isInteger(o.qty) || o.qty <= 0) {
        return { ok: false, error: `webull_trade: invalid qty ${o.qty} (positive integer required)` };
      }
      const svc = createServiceClient();
      if (!(await webullTradeOrdersEnabled(svc))) {
        return { ok: false, error: "webull_trade orders disabled (strategy_config.webull_trade_orders_enabled absent/false)" };
      }
      const acct = await resolveWebullTradingAccount(svc);
      if (!acct.ok) return { ok: false, error: acct.error };
      const cred = await getWebullTradeCredential(supabaseVaultReader(svc), "prod");
      if (!cred.ok) return { ok: false, error: cred.error };
      // If the code ever reaches here (all provisioned + flag on) the future live
      // controller wires the signed transport + full gate ladder + token check.
      // Until that phase ships and the owner runs a sandbox proof, refuse.
      return {
        ok: false,
        error: "webull_trade live submit path is not enabled — pending owner entitlement confirmation and a manually-approved sandbox test",
      };
    },

    async getOrder(_brokerOrderId, env): Promise<BrokerOrderState> {
      if (env !== "live") return { ok: false, error: "webull_trade is live-only" };
      return { ok: false, error: "webull_trade live query path is not enabled" };
    },

    async cancelOrder(_brokerOrderId, env) {
      if (env !== "live") return { ok: false, error: "webull_trade is live-only" };
      return { ok: false, error: "webull_trade live cancel path is not enabled" };
    },
  };
}
