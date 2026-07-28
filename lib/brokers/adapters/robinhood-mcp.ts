import { BrokerAdapter, BrokerOrderResult, BrokerOrderState } from "@/lib/brokers/adapter-types";
import { hasRobinhoodToken, submitRobinhoodOrder, queryRobinhoodOrder, cancelRobinhoodOrder } from "@/lib/robinhood-mcp";
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

      // Last-mile qty guard (defense in depth — the Gateway validates too, but a
      // non-gateway caller could reach the adapter via structural typing).
      if (!Number.isInteger(o.qty) || o.qty <= 0) return { ok: false, error: `Robinhood MCP: invalid qty ${o.qty} (must be a positive integer)` };

      // Defense in depth: enforce the integration's own kill switch here too,
      // not only at the Gateway.
      const svc = createServiceClient();
      const { data: cfg, error: cfgErr } = await svc.from("strategy_config").select("robinhood_mcp_enabled").limit(1).maybeSingle();
      if (cfgErr || (cfg as any)?.robinhood_mcp_enabled !== true) return { ok: false, error: "Robinhood MCP is disabled (robinhood_mcp_enabled)" };

      // Re-resolve + re-validate the trading account at the last code before the
      // wire (the Gateway checks it too — this is the redundant last line).
      const acct = await resolveTradingAccount(svc);
      if (!acct.ok) return { ok: false, error: acct.error };

      const res = await submitRobinhoodOrder({
        account: acct.account,
        symbol: o.symbol,
        side: o.side,
        qty: o.qty,
        type: o.type === "limit" ? "limit" : "market",
        limitPrice: o.limitPrice,
      });
      // Preserve needsReconcile — the Gateway needs it to avoid a duplicate.
      if (!res.ok) return { ok: false, error: res.error, needsReconcile: res.needsReconcile, raw: res.raw };
      return { ok: true, brokerOrderId: res.brokerOrderId, raw: res.raw };
    },
    async getOrder(brokerOrderId, env): Promise<BrokerOrderState> {
      if (env !== "live") return { ok: false, error: "Robinhood MCP is live-only (no paper env)" };
      const svc = createServiceClient();
      const acct = await resolveTradingAccount(svc);
      if (!acct.ok) return { ok: false, error: acct.error };
      const r = await queryRobinhoodOrder(brokerOrderId, acct.account);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, status: r.status, filledQty: r.filledQty, avgFillPrice: r.avgFillPrice, raw: r.raw };
    },
    async cancelOrder(brokerOrderId, env) {
      if (env !== "live") return { ok: false, error: "Robinhood MCP is live-only (no paper env)" };
      const configured = await hasRobinhoodToken();
      if (!configured) return { ok: false, error: "Robinhood MCP is not connected" };
      // Robinhood's cancel tool is account-scoped. Resolve the same allowlisted
      // account used for submission rather than sending an unscoped cancel or
      // guessing from a broker-order row that predates account provenance.
      const svc = createServiceClient();
      const acct = await resolveTradingAccount(svc);
      if (!acct.ok) return { ok: false, error: acct.error };
      const r = await cancelRobinhoodOrder(brokerOrderId, acct.account);
      return { ok: r.ok, error: r.error, raw: r.raw };
    },
  };
}

// Fail-closed account resolution (US trading account from the allowlist),
// mirroring the Gateway's own check so this last layer can't be bypassed. The
// allowlist row must match broker='robinhood' (the brokerage), not just the
// account number + market.
async function resolveTradingAccount(svc: any): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
  try {
    const { data: cfg, error: cfgErr } = await svc.from("strategy_config").select("active_account_us").limit(1).maybeSingle();
    if (cfgErr) return { ok: false, error: `account config read failed: ${cfgErr.message}` };
    const account = (cfg as any)?.active_account_us;
    if (!account) return { ok: false, error: "No active US trading account set" };
    const { data: allowed, error: allowErr } = await svc
      .from("broker_accounts").select("role").eq("broker", "robinhood").eq("account_number", account).eq("market", "us").maybeSingle();
    if (allowErr) return { ok: false, error: `allowlist read failed: ${allowErr.message}` };
    if (!allowed || (allowed as any).role !== "trading") return { ok: false, error: `Account ${account} is not an allowlisted robinhood trading account` };
    return { ok: true, account };
  } catch (e) { return { ok: false, error: `account resolution error: ${String(e)}` }; }
}
