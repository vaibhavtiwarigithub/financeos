import { BrokerAdapter, BrokerOrderResult, BrokerOrderState } from "@/lib/brokers/adapter-types";
import { createServiceClient } from "@/lib/supabase/service";
import { rhPlaceMarketOrder, rhGetOrder, rhCancelOrder, hasRhRestToken } from "@/lib/brokers/robinhood/rest-client";

// Robinhood via direct REST — US, live-only. SERVERLESS-CAPABLE (unlike the MCP
// adapter, which needs a live MCP session absent in Vercel route/cron handlers).
// Deterministic, no LLM. The account is allowlist-validated here (mirroring the
// gateway) as the redundant last line before the wire.
export function robinhoodAdapter(): BrokerAdapter {
  return {
    id: "robinhood",
    market: "us",
    envs: ["live"],
    async isConfigured() {
      return hasRhRestToken(createServiceClient());
    },
    async submitOrder(o): Promise<BrokerOrderResult> {
      if (o.env !== "live") return { ok: false, error: "Robinhood is live-only (no paper env)" };
      if (!Number.isInteger(o.qty) || o.qty <= 0) return { ok: false, error: `Robinhood: invalid qty ${o.qty} (must be a positive integer)` };
      const svc = createServiceClient();
      // Defense in depth: enforce the Robinhood live kill switch here too.
      const { data: cfg, error: cfgErr } = await svc.from("strategy_config").select("robinhood_mcp_enabled").limit(1).maybeSingle();
      if (cfgErr || (cfg as any)?.robinhood_mcp_enabled !== true) return { ok: false, error: "Robinhood live is disabled (robinhood_mcp_enabled)" };
      // Re-resolve + re-validate the trading account at the last code before the wire.
      const acct = await resolveTradingAccount(svc);
      if (!acct.ok) return { ok: false, error: acct.error };
      const res = await rhPlaceMarketOrder(svc, { symbol: o.symbol, qty: o.qty, side: o.side, account: acct.account });
      // AMBIGUOUS (network error, or success with no order id) → surface needsReconcile
      // so the gateway records unknown_needs_reconcile and never auto-retries.
      if (!res.ok) return { ok: false, error: res.error, needsReconcile: res.needs_reconcile, raw: res.raw };
      if (res.needs_reconcile) return { ok: false, error: res.error ?? "ambiguous submit — no order id", needsReconcile: true, raw: res.raw };
      return { ok: true, brokerOrderId: res.order_id, raw: res.raw };
    },
    async getOrder(brokerOrderId, env): Promise<BrokerOrderState> {
      if (env !== "live") return { ok: false, error: "Robinhood is live-only (no paper env)" };
      const r = await rhGetOrder(createServiceClient(), brokerOrderId);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, status: r.status, filledQty: r.filledQty, avgFillPrice: r.avgFillPrice, raw: r.raw };
    },
    async cancelOrder(brokerOrderId, env) {
      if (env !== "live") return { ok: false, error: "Robinhood is live-only (no paper env)" };
      return rhCancelOrder(createServiceClient(), brokerOrderId);
    },
  };
}

// Fail-closed account resolution (US trading account from the allowlist), the
// redundant last layer mirroring the gateway's own check.
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
