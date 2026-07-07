import { BrokerAdapter, BrokerOrderResult, BrokerOrderState } from "@/lib/brokers/adapter-types";
import { hasRobinhoodToken, submitRobinhoodOrder } from "@/lib/robinhood-mcp";
import { createServiceClient } from "@/lib/supabase/service";

// Robinhood via its remote MCP server — US, live-only. Deterministic write path
// (no LLM, per R1). isConfigured() is false until the OAuth flow (blocked on
// Robinhood's real endpoints) stores a token, so the Gateway will report
// "not configured" and never route an order here today.
export function robinhoodMcpAdapter(): BrokerAdapter {
  return {
    id: "robinhood_mcp",
    market: "us",
    envs: ["live"],
    async isConfigured() {
      return hasRobinhoodToken();
    },
    async submitOrder(o): Promise<BrokerOrderResult> {
      // Defense in depth: the Gateway already blocks non-live env, but the
      // adapter self-rejects too (structural typing means a caller could pass
      // anything).
      if (o.env !== "live") return { ok: false, error: "Robinhood MCP is live-only (no paper env)" };

      // Re-resolve + re-validate the trading account at the last code before the
      // wire (the Gateway checks it too — this is the redundant last line).
      const acct = await resolveTradingAccount();
      if (!acct.ok) return { ok: false, error: acct.error };

      const res = await submitRobinhoodOrder({
        account: acct.account,
        symbol: o.symbol,
        side: o.side,
        qty: o.qty,
        type: o.type === "limit" ? "limit" : "market",
        limitPrice: o.limitPrice,
      });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, brokerOrderId: res.brokerOrderId, raw: res.raw };
    },
    async getOrder(_brokerOrderId, _env): Promise<BrokerOrderState> {
      return { ok: false, error: "Robinhood MCP order-status not implemented in this build" };
    },
    async cancelOrder(_brokerOrderId, _env) {
      return { ok: false, error: "Robinhood MCP cancel not implemented in this build" };
    },
  };
}

// Fail-closed account resolution (US trading account from the allowlist),
// mirroring the Gateway's own check so this last layer can't be bypassed.
async function resolveTradingAccount(): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
  try {
    const svc = createServiceClient();
    const { data: cfg, error: cfgErr } = await svc.from("strategy_config").select("active_account_us").limit(1).maybeSingle();
    if (cfgErr) return { ok: false, error: `account config read failed: ${cfgErr.message}` };
    const account = (cfg as any)?.active_account_us;
    if (!account) return { ok: false, error: "No active US trading account set" };
    const { data: allowed, error: allowErr } = await svc
      .from("broker_accounts").select("role").eq("account_number", account).eq("market", "us").maybeSingle();
    if (allowErr) return { ok: false, error: `allowlist read failed: ${allowErr.message}` };
    if (!allowed || (allowed as any).role !== "trading") return { ok: false, error: `Account ${account} is not an allowlisted trading account` };
    return { ok: true, account };
  } catch (e) { return { ok: false, error: `account resolution error: ${String(e)}` }; }
}
