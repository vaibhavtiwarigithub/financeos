import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  rh: vi.fn(), kite: vi.fn(), all: vi.fn(), alpaca: vi.fn(), identity: vi.fn(),
  rpc: vi.fn(), auth: vi.fn(), connected: vi.fn(), capture: vi.fn(),
}));
vi.mock("@/lib/auth/cron", () => ({ verifyCronSecret: mocks.auth }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({
  from: () => ({ select: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  rpc: mocks.rpc,
}) }));
vi.mock("@/lib/brokers", () => ({ fetchRobinhoodBrokerAccounts: mocks.rh, fetchKiteBrokerAccount: mocks.kite, fetchAllAccounts: mocks.all }));
vi.mock("@/lib/brokers/alpaca", () => ({ fetchAlpacaAccount: mocks.alpaca }));
vi.mock("@/lib/brokers/mcp-registry", () => ({ MCP_BROKERS: {
  webull: { id: "webull", label: "Webull", market: "us" },
} }));
vi.mock("@/lib/brokers/mcp-driver", () => ({ hasToken: mocks.connected, captureAccounts: mocks.capture }));
vi.mock("@/lib/kite", () => ({ verifyKiteTradingIdentity: mocks.identity }));
vi.mock("@/lib/portfolio-risk", () => ({ computeRiskMetrics: vi.fn() }));
vi.mock("@/lib/data/candles", () => ({ fetchUsCandles: vi.fn() }));
vi.mock("@/lib/india-data", () => ({ fetchYahooCandles: vi.fn() }));
vi.mock("@/lib/risk/strategy-notes", () => ({ strategyNotes: vi.fn() }));
import { POST } from "@/app/api/agents/holding-risk/route";

function account(source: string, accountId: string) {
  return { source, accountId, totalValue: 100, cashBalance: 0, fetchedAt: "2026-10-23T20:00:00Z",
    holdings: [{ symbol: source === "kite" ? "INFY.NS" : "AAPL", qty: 1, currentPrice: 100, marketValue: 100, side: "long", source }] };
}
async function run(market: string) {
  return POST(new NextRequest(`https://example.test/api/agents/holding-risk?market=${market}`, { method: "POST" }));
}
describe("daily live holding-risk universe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockReturnValue(true);
    mocks.rh.mockResolvedValue([account("robinhood", "rh-test")]);
    mocks.alpaca.mockResolvedValue(account("alpaca_live", "alpaca-test"));
    mocks.kite.mockResolvedValue(account("kite", "kite_india"));
    mocks.identity.mockResolvedValue({ ok: true, account: "verified-kite-test" });
    mocks.connected.mockResolvedValue(false);
    mocks.capture.mockResolvedValue([account("webull", "webull-test")]);
    mocks.all.mockImplementation(async (market: string) => market === "india"
      ? [account("internal", "internal")]
      : [account("internal", "internal"), account("alpaca_paper", "paper-test"), account("alpaca_live", "alpaca-test")]);
    // Exercise admission/claims without running providers, inference or publication.
    mocks.rpc.mockResolvedValue({ data: { is_new: false, status: "complete" } });
  });
  it("claims US live broker accounts only and never fetches simulated books", async () => {
    const response = await run("us");
    expect(response.status).toBe(200);
    expect(mocks.all).not.toHaveBeenCalled();
    expect(mocks.alpaca).toHaveBeenCalledExactlyOnceWith(false);
    expect(mocks.rpc.mock.calls.map((call) => call[1].p_broker)).toEqual(["robinhood", "alpaca_live"]);
  });
  it("uses verified India holdings without paper or US accounts", async () => {
    await run("india");
    expect(mocks.all).not.toHaveBeenCalled();
    expect(mocks.alpaca).not.toHaveBeenCalled();
    expect(mocks.rh).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("claim_holding_risk_run", expect.objectContaining({ p_broker: "kite", p_account_id: "verified-kite-test", p_currency: "INR" }));
  });
  it("does not substitute a paper book when the live India identity is unavailable", async () => {
    mocks.identity.mockResolvedValue({ ok: false, error: "login_required" });
    const payload = await (await run("india")).json();
    expect(payload.accounts_completed).toBe(0);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.all).not.toHaveBeenCalled();
  });
  it("includes a connected Webull live account without merging its same-symbol position into Robinhood", async () => {
    mocks.connected.mockResolvedValue(true);
    await run("us");
    expect(mocks.capture).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "webull", market: "us" }));
    expect(mocks.rpc.mock.calls.map(call => [call[1].p_broker, call[1].p_account_id])).toEqual([
      ["robinhood", "rh-test"], ["alpaca_live", "alpaca-test"], ["webull", "webull-test"],
    ]);
    expect(mocks.all).not.toHaveBeenCalled();
  });
  it("never fetches US registry accounts for India or an unconnected optional broker", async () => {
    await run("india");
    expect(mocks.connected).not.toHaveBeenCalled();
    await run("us");
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it("does not invent a verified identity or paper fallback when a connected broker fails", async () => {
    mocks.connected.mockResolvedValue(true);
    mocks.capture.mockResolvedValue([{ ...account("webull", "unknown"), error: "broker unavailable" }]);
    const payload = await (await run("us")).json();
    expect(mocks.rpc.mock.calls.map(call => call[1].p_broker)).toEqual(["robinhood", "alpaca_live"]);
    expect(payload.outcomes).toContainEqual(expect.objectContaining({ broker: "webull", status: "skipped", reason: "no broker-verified account id" }));
    expect(mocks.all).not.toHaveBeenCalled();
  });
  it("keeps other live accounts readable when the optional connected provider throws", async () => {
    mocks.connected.mockResolvedValue(true);
    mocks.capture.mockRejectedValue(new Error("provider outage"));
    const payload = await (await run("us")).json();
    expect(mocks.rpc.mock.calls.map(call => call[1].p_broker)).toEqual(["robinhood", "alpaca_live"]);
    expect(payload.outcomes).toContainEqual(expect.objectContaining({ broker: "webull", reason: "connected broker account capture failed" }));
  });
});
