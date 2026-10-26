import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ credentials: vi.fn(), fetch: vi.fn(), report: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/brokers/alpaca-credentials", () => ({ getAlpacaCredentials: mocks.credentials }));
vi.mock("@/lib/data/provider-fetch", () => ({ providerCachedFetch: mocks.fetch }));
vi.mock("@/lib/system-health", () => ({ reportIssue: mocks.report, resolveIssue: mocks.resolve }));
import { fetchAlpacaActivityCandidates, parseAlpacaActivity } from "@/lib/data/alpaca-market-data";
import { balancedDiscoveryOrder } from "@/lib/research-queue";

const now = new Date("2026-10-26T15:00:00Z");
const actives = { last_updated: "2026-10-26T14:59:00Z", most_actives: [
  { symbol: "AAA", volume: 900000 }, { symbol: "BBB", volume: 700000 }, { symbol: "PENNY", volume: 100 }, { symbol: "BAD-P", volume: 900000 },
] };
const movers = { market_type: "stocks", last_updated: "2026-10-26T14:59:00Z", gainers: [
  { symbol: "BBB", price: 20, percent_change: 4 }, { symbol: "XYZ", price: 2, percent_change: 80 },
] };
describe("Alpaca discovery-only activity", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.credentials.mockResolvedValue({ key: "fixture", secret: "fixture" }); });
  afterEach(() => { vi.useRealTimers(); });
  it("accepts provider timestamps arriving during the fetch against the post-fetch clock", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const duringFetch = "2026-10-26T15:00:01Z";
    mocks.fetch.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 1500));
      return { ...actives, last_updated: duringFetch };
    })
      .mockResolvedValueOnce({ ...movers, last_updated: duringFetch });
    const pending = fetchAlpacaActivityCandidates();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).map(row => row.symbol)).toEqual(["BBB", "AAA"]);
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("ranks a liquid gainer and retains source time separately from fetch time", () => {
    const rows = parseAlpacaActivity(actives, movers, now);
    expect(rows.map(row => row.symbol)).toEqual(["BBB", "AAA"]);
    expect(rows[0].context).toMatchObject({ lane: "gainer", data_session: "2026-10-26", feed: "sip_screener", source_as_of: "2026-10-26T14:59:00.000Z", fetched_at: now.toISOString() });
  });
  it("rejects stale, future, pre-open and cross-market payloads", () => {
    for (const last_updated of ["2026-10-26T14:00:00Z", "2026-10-26T15:01:00Z", "2026-10-26T13:29:00Z"])
      expect(parseAlpacaActivity({ ...actives, last_updated }, movers, now)).toEqual([]);
    expect(parseAlpacaActivity(actives, { ...movers, market_type: "crypto" }, now)).toEqual([]);
    expect(parseAlpacaActivity(actives, movers, new Date("2026-10-26T13:00:00Z"))).toEqual([]);
  });
  it("uses no credentials or provider calls out of session or for optional unconfigured accounts", async () => {
    expect(await fetchAlpacaActivityCandidates(new Date("2026-10-25T15:00:00Z"))).toEqual([]);
    expect(mocks.credentials).not.toHaveBeenCalled();
    mocks.credentials.mockResolvedValue(null);
    expect(await fetchAlpacaActivityCandidates(now)).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("surfaces configured provider failures without inventing candidates", async () => {
    mocks.fetch.mockResolvedValue(null);
    expect(await fetchAlpacaActivityCandidates(now)).toEqual([]);
    expect(mocks.report).toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("does not call a verified empty result a provider failure", async () => {
    mocks.fetch.mockResolvedValueOnce({ ...actives, most_actives: [] }).mockResolvedValueOnce({ ...movers, gainers: [] });
    expect(await fetchAlpacaActivityCandidates(now)).toEqual([]);
    expect(mocks.report).not.toHaveBeenCalled(); expect(mocks.resolve).toHaveBeenCalled();
  });
  it("shares discovery slots fairly without duplicating candidates or growing a cap", () => {
    const items = ["fund", "fund", "fund", "activity", "activity", "edge", "benchmark"].map((lane, i) => ({ lane, symbol: String(i) }));
    expect(balancedDiscoveryOrder(items).slice(0, 4)).toEqual(["0", "3", "5", "6"]);
    expect(balancedDiscoveryOrder([...items, items[0]]).length).toBe(items.length);
  });
});
