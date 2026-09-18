import { describe, expect, it } from "vitest";
import {
  buildRobinhoodCryptoQuoteArgs,
  parseRobinhoodCryptoOnboarding,
  parseRobinhoodCryptoPairs,
  parseRobinhoodCryptoQuotes,
} from "@/lib/robinhood-mcp";

describe("Robinhood crypto read contract", () => {
  it("accepts only an explicit, fully satisfiable quote schema", () => {
    expect(buildRobinhoodCryptoQuoteArgs({ properties: { symbols: { type: "array" } }, required: ["symbols"] }, ["BTC", "ETH"]))
      .toEqual({ symbols: ["BTC", "ETH"] });
    expect(buildRobinhoodCryptoQuoteArgs({ properties: { symbols: { type: "array" }, account: { type: "string" } }, required: ["symbols", "account"] }, ["BTC"]))
      .toBeNull();
  });

  it("records an executable two-sided quote but does not infer tradability", () => {
    const quotes = parseRobinhoodCryptoQuotes({ quotes: [{ symbol: "BTC-USD", bid_price: "100", ask_price: "101" }] }, "2026-09-17T00:00:00.000Z");
    expect(quotes.get("BTC")).toEqual({ symbol: "BTC", bid: 100, ask: 101, observedAt: "2026-09-17T00:00:00.000Z" });
    expect(parseRobinhoodCryptoQuotes({ quotes: [{ symbol: "BTC", bid: 101, ask: 100 }] }, "now").size).toBe(0);
  });

  it("requires affirmative broker onboarding evidence", () => {
    expect(parseRobinhoodCryptoOnboarding({ already_onboarded: true })).toBe(true);
    expect(parseRobinhoodCryptoOnboarding({ status: "unknown" })).toBe(false);
  });

  it("requires explicit broker tradability and preserves the broker pair identifier", () => {
    const pairs = parseRobinhoodCryptoPairs({ currency_pairs: [
      { symbol: "BTC-USD", tradable: true },
      { base_currency: "ETH", quote_currency: "USD", is_tradable: false },
      { symbol: "SOL-EUR", tradable: true },
    ] });
    expect(pairs.get("BTC")).toEqual({ symbol: "BTC", brokerPair: "BTC-USD", tradeable: true });
    expect(pairs.get("ETH")).toEqual({ symbol: "ETH", brokerPair: "ETH-USD", tradeable: false });
    expect(pairs.has("SOL")).toBe(false);
  });
});
