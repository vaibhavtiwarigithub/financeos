import { describe, expect, it } from "vitest";
import { symbolsFromLatestLiveSnapshots, symbolsFromPaperPositions, unionHoldingSymbols } from "./holding-symbols";

describe("holding research symbols", () => {
  it("uses only the latest snapshot for each live account", () => {
    expect(symbolsFromLatestLiveSnapshots([
      { broker: "robinhood", account_id: "a", captured_at: "2026-07-15", positions_json: [{ symbol: "OLD", qty: 1 }] },
      { broker: "robinhood", account_id: "a", captured_at: "2026-07-16", positions_json: [{ symbol: "AAPL", qty: 2 }] },
      { broker: "robinhood", account_id: "b", captured_at: "2026-07-16", positions_json: [{ symbol: "MSFT", qty: 1 }] },
    ])).toEqual(["AAPL", "MSFT"]);
  });

  it("normalizes positive paper positions per market", () => {
    expect(symbolsFromPaperPositions([{ symbol: "reliance", qty: 2 }, { symbol: "ZERO", qty: 0 }], "india")).toEqual(["RELIANCE.NS"]);
    expect(symbolsFromPaperPositions([{ symbol: "aapl", qty: 1 }], "us")).toEqual(["AAPL"]);
  });

  it("deduplicates paper and live holdings", () => {
    expect(unionHoldingSymbols(["AAPL", "MSFT"], ["aapl", "NVDA"])).toEqual(["AAPL", "MSFT", "NVDA"]);
  });
});
