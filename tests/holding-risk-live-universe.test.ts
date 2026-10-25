import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  rh: vi.fn(), kite: vi.fn(), all: vi.fn(), alpaca: vi.fn(), identity: vi.fn(),
  rpc: vi.fn(), auth: vi.fn(),
}));
vi.mock("@/lib/auth/cron", () => ({ verifyCronSecret: mocks.auth }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({
  from: () => ({ select: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  rpc: mocks.rpc,
}) }));
vi.mock("@/lib/brokers", () => ({ fetchRobinhoodBrokerAccounts: mocks.rh, fetchKiteBrokerAccount: mocks.kite, fetchAllAccounts: mocks.all }));
vi.mock("@/lib/brokers/alpaca", () => ({ fetchAlpacaAccount: mocks.alpaca }));
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
});
