import { describe, expect, it } from "vitest";
import { buildAtrForwardSession, type AtrForwardSessionInput } from "./atr-forward-session";

const now = new Date("2026-09-28T22:00:00.000Z");
const book = {
  market: "us" as const,
  session: "2026-09-25",
  cash: 800,
  positions: [{ symbol: "ABC", quantity: 2, costBasis: 100, initialStopLoss: 90, currentStop: 90,
    priceTarget: 120, highestPrice: 100, applyAtrStop: false, partialTaken: false }],
};
const coverage = ["split", "dividend"].map((action_type) => ({
  symbol: "ABC", action_type, status: "complete", checked_at: "2026-09-28T21:00:00.000Z",
  provider_fetched_at: "2026-09-28T21:00:00.000Z", records_count: 0,
}));

function input(overrides: Partial<AtrForwardSessionInput> = {}): AtrForwardSessionInput {
  return {
    market: "us", session: "2026-09-28", baselineBook: structuredClone(book), variantBook: structuredClone(book),
    bars: [{ symbol: "ABC", open: 101, high: 103, low: 99, close: 102 }], benchmarkClose: 500,
    yahooActions: [], corporateActionLedger: [], corporateActionCoverage: coverage,
    entries: [], externalExits: [], costs: { version: "recorded-fills-plus-5bps-modeled-v1", sellCostBps: 5 }, now,
    ...overrides,
  };
}

describe("buildAtrForwardSession", () => {
  it("builds matched session books and marks only from one raw, action-validated input", () => {
    const result = buildAtrForwardSession(input());
    expect(result.baselineBook.session).toBe("2026-09-28");
    expect(result.variantBook.session).toBe("2026-09-28");
    expect(result.mark).toEqual({ session: "2026-09-28", prices: { ABC: 102 }, benchClose: 500 });
    expect(result.baselineEvents).toEqual([]);
    expect(result.variantEvents).toEqual([]);
    expect(result.turnoverNotional).toBe(0);
  });

  it("refuses a missing held-name raw OHLC bar", () => {
    expect(() => buildAtrForwardSession(input({ bars: [] }))).toThrow(/lacks raw OHLC/);
  });

  it("refuses any unverified or conflicting corporate-action coverage", () => {
    expect(() => buildAtrForwardSession(input({ corporateActionCoverage: [] }))).toThrow(/corporate-action gate failed/);
    expect(() => buildAtrForwardSession(input({
      yahooActions: [{ symbol: "ABC", session: "2026-09-28", type: "split", splitRatio: 2 }],
    }))).toThrow(/disagrees between raw-bar provider and persisted action ledger/);
  });

  it("preserves the existing book identically in both arms until new policy entries occur", () => {
    const result = buildAtrForwardSession(input());
    expect(result.baselineBook.positions).toEqual(result.variantBook.positions);
    expect(result.diagnostics).toEqual({ baselineExitCount: 0, variantExitCount: 0, entryCount: 0, atrUnavailableEntryIds: [], grossDividendCash: 0 });
  });
});
