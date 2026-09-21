import { describe, expect, it } from "vitest";
import { cryptoResearchInventory } from "./crypto-research-inventory";

describe("crypto paper research inventory", () => {
  it("prioritizes all three approved paper names even with a partial broker inventory", () => {
    const rows = cryptoResearchInventory(Array.from({length: 22}, (_, i) => ({symbol: `ALT${i}`, brokerPair: `ALT${i}-USD`, tradeable: true})));
    expect(rows.slice(0, 3).map(p => p.symbol)).toEqual(["BTC-USD", "ETH-USD", "SOL-USD"]);
    expect(rows.slice(0, 3).every(p => !p.tradeable)).toBe(true);
  });
  it("normalizes base tickers and deduplicates without inventing broker eligibility", () => {
    const rows = cryptoResearchInventory([{symbol: "BTC", brokerPair: "BTC/USD", tradeable: true}, {symbol: "BTC-USD", brokerPair: "BTC/USD", tradeable: true}]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({symbol: "BTC-USD", brokerPair: "BTC/USD", tradeable: true});
    expect(rows[1].tradeable).toBe(false);
  });
});
