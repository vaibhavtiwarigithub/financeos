// webull_trade — adapter fails closed today (flag absent, no allowlist, no cred),
// and the protective-capability declaration matches the proven scope.
import { describe, it, expect, vi, beforeEach } from "vitest";

// A configurable fake Supabase service client. `flagValue` and `accounts` drive
// the three fail-closed conditions the adapter checks.
let flagError = true;      // column absent → error → false
let flagValue: any = null;
let accountRows: any[] = [];
let vaultRows: Record<string, string> = {}; // key_name -> value (provider webull_trade)

function fakeSvc() {
  return {
    from(table: string) {
      const chain: any = {
        _table: table,
        _filters: {} as Record<string, any>,
        select() { return chain; },
        eq(col: string, val: any) { chain._filters[col] = val; return chain; },
        limit() { return chain; },
        async maybeSingle() {
          if (table === "strategy_config") {
            if (flagError) return { data: null, error: { message: "column does not exist", code: "42703" } };
            return { data: { webull_trade_orders_enabled: flagValue }, error: null };
          }
          if (table === "api_key_vault") {
            const key = chain._filters["key_name"];
            const provider = chain._filters["provider"];
            if (provider !== "webull_trade") return { data: null, error: null };
            const v = vaultRows[key];
            return { data: v ? { key_value: v } : null, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve: any) {
          // broker_accounts list query resolves as an array (no maybeSingle)
          if (table === "broker_accounts") return resolve({ data: accountRows, error: null });
          return resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };
}

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => fakeSvc() }));

import { webullTradeAdapter } from "@/lib/brokers/webull-trade/adapter";
import { WEBULL_TRADE_PROTECTIVE_CAPABILITIES } from "@/lib/brokers/webull-trade/capabilities";
import { clearCredentialCache } from "@/lib/brokers/webull-trade/credentials";

describe("webull_trade adapter — fail closed today", () => {
  beforeEach(() => {
    flagError = true; flagValue = null; accountRows = []; vaultRows = {};
    clearCredentialCache();
  });

  it("id is webull_trade and market/env are US/live", () => {
    const a = webullTradeAdapter();
    expect(a.id).toBe("webull_trade");
    expect(a.market).toBe("us");
    expect(a.envs).toEqual(["live"]);
  });

  it("isConfigured() is false when the flag column is absent (prod state)", async () => {
    const a = webullTradeAdapter();
    expect(await a.isConfigured()).toBe(false);
  });

  it("isConfigured() stays false with the flag on but no allowlisted account", async () => {
    flagError = false; flagValue = true; accountRows = [];
    expect(await webullTradeAdapter().isConfigured()).toBe(false);
  });

  it("isConfigured() stays false with flag on + one account but no vault credential", async () => {
    flagError = false; flagValue = true;
    accountRows = [{ account_number: "WBACCT1", role: "trading" }];
    vaultRows = {}; // no webull_trade prod credential
    expect(await webullTradeAdapter().isConfigured()).toBe(false);
  });

  it("submitOrder refuses in a paper env", async () => {
    const r = await webullTradeAdapter().submitOrder({ symbol: "AAPL", side: "buy", qty: 1, env: "paper" });
    expect(r.ok).toBe(false);
  });

  it("submitOrder fails closed on the absent flag before any wire access", async () => {
    const r = await webullTradeAdapter().submitOrder({ symbol: "AAPL", side: "buy", qty: 1, env: "live" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/disabled/);
  });

  it("submitOrder refuses even fully provisioned (live path pending sandbox proof)", async () => {
    flagError = false; flagValue = true;
    accountRows = [{ account_number: "WBACCT1", role: "trading" }];
    vaultRows = { WEBULL_TRADE_PROD_APP_KEY: "k", WEBULL_TRADE_PROD_APP_SECRET: "s" };
    const r = await webullTradeAdapter().submitOrder({ symbol: "AAPL", side: "buy", qty: 1, env: "live" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not enabled|sandbox/);
  });

  it("getOrder/cancelOrder refuse (live path not enabled)", async () => {
    const a = webullTradeAdapter();
    expect((await a.getOrder("x", "live")).ok).toBe(false);
    expect((await a.cancelOrder("x", "live")).ok).toBe(false);
  });
});

describe("webull_trade protective capabilities", () => {
  it("declares only US equity sell_long via GTC stop-market in the regular session", () => {
    const c = WEBULL_TRADE_PROTECTIVE_CAPABILITIES;
    expect(c.scope.market).toBe("us");
    expect(c.scope.sides).toEqual(["sell_long"]);
    expect(c.orders.stop_market?.timeInForce).toEqual(["gtc"]);
    expect(c.orders.stop_market?.sessions).toEqual(["regular"]);
    // Never declares extended/overnight, and no OCO, and no stop_limit/gtt_limit.
    expect(c.orders.stop_market?.sessions).not.toContain("extended");
    expect(c.orders.stop_market?.oco).toBe(false);
    expect(c.orders.stop_limit).toBeUndefined();
    expect(c.orders.gtt_limit).toBeUndefined();
  });
});
