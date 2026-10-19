import { describe, expect, it } from "vitest";
import { __test } from "@/lib/evidence/adapters/robinhood-mcp";

describe("Robinhood MCP quote contract", () => {
  const now = Date.parse("2026-10-19T15:00:00.000Z");

  it("accepts fresh, uncrossed two-sided quotes with aligned venue times", () => {
    const quote = __test.normalizeQuote("AAPL", {
      symbol: "AAPL", bid_price: "251.10", ask_price: "251.12",
      venue_bid_time: "2026-10-19T14:59:55.000Z", venue_ask_time: "2026-10-19T14:59:56.000Z",
    }, now);
    expect(quote).toMatchObject({ symbol: "AAPL", bid: 251.1, ask: 251.12, mid: 251.11, source: "robinhood_mcp" });
  });

  it.each([
    ["stale", { venue_bid_time: "2026-10-19T14:00:00.000Z", venue_ask_time: "2026-10-19T14:00:00.000Z" }],
    ["missing venue timestamps", { venue_bid_time: null, venue_ask_time: null }],
    ["crossed market", { bid_price: 252, ask_price: 251, venue_bid_time: "2026-10-19T14:59:55.000Z", venue_ask_time: "2026-10-19T14:59:56.000Z" }],
    ["mismatched symbol", { symbol: "MSFT", bid_price: 251, ask_price: 252, venue_bid_time: "2026-10-19T14:59:55.000Z", venue_ask_time: "2026-10-19T14:59:56.000Z" }],
  ])("rejects %s", (_label, changes) => {
    const quote = __test.normalizeQuote("AAPL", {
      symbol: "AAPL", bid_price: 251, ask_price: 252,
      venue_bid_time: "2026-10-19T14:59:55.000Z", venue_ask_time: "2026-10-19T14:59:56.000Z",
      ...(changes as object),
    }, now);
    expect(quote).toBeNull();
  });
});
