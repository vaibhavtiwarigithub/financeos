import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("@/lib/robinhood-mcp", () => ({ readRobinhoodLeveragedQuoteRows: vi.fn() }));

import { readRobinhoodLeveragedQuoteRows } from "@/lib/robinhood-mcp";
import { getLeveragedExecutableQuotes } from "@/lib/data/leveraged-intraday-quotes";

const now = new Date("2026-10-16T15:05:00.000Z");
const row = (symbol: string) => ({
  symbol, bid_price: "40.00", ask_price: "40.04",
  venue_bid_time: "2026-10-16T15:04:30Z", venue_ask_time: "2026-10-16T15:04:31Z",
});

describe("leveraged broker quote transport", () => {
  afterEach(() => { vi.useRealTimers(); vi.mocked(readRobinhoodLeveragedQuoteRows).mockReset(); });

  it("requests a bounded batch once and returns only venue-timestamped bid/ask pairs", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    vi.mocked(readRobinhoodLeveragedQuoteRows).mockResolvedValue([row("SOXL"), row("SOXS"), { ...row("TQQQ"), venue_ask_time: null }]);
    const result = await getLeveragedExecutableQuotes(["SOXL", "SOXS", "TQQQ"]);
    expect(readRobinhoodLeveragedQuoteRows).toHaveBeenCalledOnce();
    expect(readRobinhoodLeveragedQuoteRows).toHaveBeenCalledWith(["SOXL", "SOXS", "TQQQ"]);
    expect(result.get("SOXL")).toMatchObject({ bid: 40, ask: 40.04, source: "robinhood_mcp",
      bidObservedAt: "2026-10-16T15:04:30.000Z", askObservedAt: "2026-10-16T15:04:31.000Z",
      observedAt: "2026-10-16T15:04:30.000Z" });
    expect(result.get("SOXS")).toBeDefined();
    expect(result.has("TQQQ")).toBe(false);
  });

  it("never turns a disconnected broker into modeled bid/ask", async () => {
    vi.mocked(readRobinhoodLeveragedQuoteRows).mockRejectedValue(new Error("not connected"));
    expect((await getLeveragedExecutableQuotes(["SOXL"])).size).toBe(0);
  });

  it("refuses symbols outside the approved leveraged quote universe", async () => {
    await expect(getLeveragedExecutableQuotes(["AAPL" as never])).rejects.toThrow("allowlist");
    expect(readRobinhoodLeveragedQuoteRows).not.toHaveBeenCalled();
  });
  it("persists both validated venue times in new collection evidence without inventing legacy values", () => {
    const route = readFileSync("app/api/agents/leveraged-etf-shadow/collect/route.ts", "utf8");
    expect(route).toContain("bid_observed_at: brokerQuote?.bidObservedAt ?? null");
    expect(route).toContain("ask_observed_at: brokerQuote?.askObservedAt ?? null");
  });
});
