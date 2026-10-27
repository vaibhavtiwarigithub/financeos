import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ capture: vi.fn(), upsert: vi.fn() }));
vi.mock("@/lib/research-agent", () => ({ fetchAndStoreAccountSnapshot: vi.fn() }));
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: async () => null }));
vi.mock("@/lib/auth/cron", () => ({ verifyCronSecret: () => false }));
vi.mock("@/lib/robinhood-mcp", () => ({ captureAllRobinhoodAccounts: mocks.capture }));
vi.mock("@/lib/brokers/mcp-registry", () => ({ MCP_BROKERS: [] }));
vi.mock("@/lib/brokers/mcp-driver", () => ({ captureAccounts: vi.fn(), hasToken: async () => false }));
vi.mock("@/lib/brokers/alpaca", () => ({ fetchAlpacaAccount: async () => ({ error: "No complete API credential pair configured" }) }));
vi.mock("@/lib/kite", () => ({ getAccessToken: async () => ({ fresh: false }), getKiteProfile: async () => ({ ok: false, error: "not connected" }), getKiteHoldings: async () => ({ ok: false }), getKiteMargins: async () => ({ ok: false }) }));
vi.mock("@/lib/india-data", () => ({ fetchIndiaQuote: vi.fn() }));
vi.mock("@/lib/system-health", () => ({ reportIssue: async () => {}, resolveIssue: async () => {} }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ from: (table: string) => {
  if (table === "strategy_config") return { select: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { live_account_source: "robinhood_mcp", robinhood_mcp_enabled: true, active_account_us: "synthetic-account" } }) }) }) };
  return { upsert: async (rows: unknown) => { if (table === "live_account_snapshots") mocks.upsert(rows); return { error: null }; }, delete: () => ({ eq: () => ({ not: () => ({ select: async () => ({ data: [], error: null }) }) }) }) };
} }) }));
import { POST } from "@/app/api/live-account/refresh-snapshot/route";
const request = () => new NextRequest("https://example.test/api/live-account/refresh-snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

describe("Robinhood snapshot count and holdings share a single fresh write", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("MASSIVE_API_KEY", ""); vi.stubGlobal("fetch", vi.fn(() => { throw Error("unexpected network"); })); });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it("replaces stale metadata with the captured holdings count in the same upsert", async () => {
    mocks.capture.mockResolvedValue([{ accountId: "synthetic-account", totalValue: 1000, holdings: [{ symbol: "VOO", qty: 1, currentPrice: 400 }, { symbol: "GLD", qty: 2, currentPrice: 100 }] }]);
    expect((await POST(request())).status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledOnce();
    const [row] = mocks.upsert.mock.calls[0][0];
    expect(row.position_count).toBe(2);
    expect(row.positions_json).toHaveLength(row.position_count);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves prior snapshots when capture fails rather than writing an empty count", async () => {
    mocks.capture.mockResolvedValue([{ accountId: "synthetic-account", error: "offline" }]);
    expect((await POST(request())).status).toBe(500);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
