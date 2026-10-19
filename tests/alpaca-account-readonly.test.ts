import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/brokers/alpaca-credentials", () => ({
  getAlpacaCredentials: vi.fn(async () => ({ key: "test-key", secret: "test-secret" })),
}));

import { fetchAlpacaAccount } from "@/lib/brokers/alpaca";

afterEach(() => vi.unstubAllGlobals());

describe("Alpaca account reads", () => {
  it("reads live account, positions and configuration with GET only and maps account state", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      const url = String(input);
      const body = url.endsWith("/v2/account")
        ? { id: "synthetic-account-id", status: "ACTIVE", account_blocked: false, trading_blocked: false, transfers_blocked: false, shorting_enabled: false, equity: "1000", portfolio_value: "1000", cash: "1000", buying_power: "1000" }
        : url.endsWith("/v2/positions") ? []
          : { fractional_trading: true, suspend_trade: false, closing_transactions_only: false };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    const account = await fetchAlpacaAccount(false);
    expect(calls).toHaveLength(3);
    expect(calls.every(call => call.method === "GET")).toBe(true);
    expect(calls.map(call => new URL(call.url).pathname)).toEqual([
      "/v2/account", "/v2/positions", "/v2/account/configurations",
    ]);
    expect(account).toMatchObject({
      source: "alpaca_live",
      accountId: "synthetic-account-id",
      accountStatus: "ACTIVE",
      accountBlocked: false,
      tradingBlocked: false,
      totalValue: 1000,
      accountState: { fractional_trading: true, account_blocked: false, trading_blocked: false },
      holdings: [],
    });
  });
});
