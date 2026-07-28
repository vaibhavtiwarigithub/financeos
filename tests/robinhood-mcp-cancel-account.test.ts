import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelRobinhoodOrder: vi.fn(),
  queryRobinhoodOrder: vi.fn(),
  hasRobinhoodToken: vi.fn(),
  createServiceClient: vi.fn(),
}));

vi.mock("@/lib/robinhood-mcp", () => ({
  cancelRobinhoodOrder: mocks.cancelRobinhoodOrder,
  hasRobinhoodToken: mocks.hasRobinhoodToken,
  queryRobinhoodOrder: mocks.queryRobinhoodOrder,
  submitRobinhoodOrder: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.createServiceClient }));

import { robinhoodMcpAdapter } from "@/lib/brokers/adapters/robinhood-mcp";

function service(account: string | null, allowlisted: boolean) {
  return {
    from(table: string) {
      const chain: any = {
        select: () => chain,
        limit: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (table === "strategy_config") return { data: { active_account_us: account }, error: null };
          if (table === "broker_accounts") return { data: allowlisted ? { role: "trading" } : null, error: null };
          return { data: null, error: new Error(`unexpected table ${table}`) };
        },
      };
      return chain;
    },
  };
}

describe("Robinhood MCP order cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasRobinhoodToken.mockResolvedValue(true);
    mocks.cancelRobinhoodOrder.mockResolvedValue({ ok: true });
    mocks.queryRobinhoodOrder.mockResolvedValue({ ok: true, status: "submitted" });
    mocks.createServiceClient.mockReturnValue(service("605420660", true));
  });

  it("passes the proven allowlisted account to the account-scoped cancel tool", async () => {
    const result = await robinhoodMcpAdapter().cancelOrder("order-1", "live");

    expect(result.ok).toBe(true);
    expect(mocks.cancelRobinhoodOrder).toHaveBeenCalledWith("order-1", "605420660");
  });

  it("fails closed instead of attempting an unscoped cancellation", async () => {
    mocks.createServiceClient.mockReturnValue(service(null, false));

    const result = await robinhoodMcpAdapter().cancelOrder("order-1", "live");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no active us trading account/i);
    expect(mocks.cancelRobinhoodOrder).not.toHaveBeenCalled();
  });

  it("passes the proven allowlisted account to account-scoped reconciliation", async () => {
    const result = await robinhoodMcpAdapter().getOrder("order-1", "live");

    expect(result.ok).toBe(true);
    expect(mocks.queryRobinhoodOrder).toHaveBeenCalledWith("order-1", "605420660");
  });

  it("fails closed instead of attempting unscoped reconciliation", async () => {
    mocks.createServiceClient.mockReturnValue(service(null, false));

    const result = await robinhoodMcpAdapter().getOrder("order-1", "live");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no active us trading account/i);
    expect(mocks.queryRobinhoodOrder).not.toHaveBeenCalled();
  });
});
