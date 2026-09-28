import { describe, expect, it } from "vitest";
import { advanceAtrStopReplaySession, type AtrStopReplayStepInput } from "@/lib/shadows/atr-stop-forward-replay";
import { atrStopStepToPortfolioEvents } from "@/lib/shadows/atr-stop-paired-events";

const seed: AtrStopReplayStepInput["book"] = {
  market: "us", session: "2026-09-25", cash: 800,
  positions: [{ symbol: "ABC", quantity: 2, costBasis: 100, initialStopLoss: 90, currentStop: 90,
    priceTarget: 120, highestPrice: 100, applyAtrStop: false, partialTaken: false }],
};

function input(overrides: Partial<AtrStopReplayStepInput> = {}): AtrStopReplayStepInput {
  return {
    market: "us", arm: "baseline", priceBasis: "raw_ohlc", session: "2026-09-28",
    book: seed, bars: [{ symbol: "ABC", open: 103, high: 107, low: 102, close: 106 }],
    corporateActions: [], entries: [], costs: { version: "sell-slip-5bps-v1", sellCostBps: 5 }, ...overrides,
  };
}

describe("ATR stop paired-event adapter", () => {
  it("uses modeled sell costs on simulated barriers but not on already-slipped recorded fills", () => {
    const step = input({
      externalExits: [{ symbol: "ABC", quantity: 2, fillPrice: 105.947, filledAt: "2026-09-28T20:15:00.000Z", reason: "manual" }],
    });
    const result = advanceAtrStopReplaySession(step);
    const adapted = atrStopStepToPortfolioEvents({ step, result });
    expect(adapted.events).toMatchObject([{ kind: "exit", price: 105.947, costPct: 0, afterEntry: false }]);
    expect(adapted.diagnostics).toMatchObject({ exits: 1, recordedExitFillCount: 1, modeledExitCostBps: 5 });
  });

  it("links every entry event to the exact shared point-in-time decision population", () => {
    const entry = {
      decisionId: "decision-1", symbol: "XYZ", session: "2026-09-28", filledAt: "2026-09-28T15:00:00.000Z",
      quantity: 1, fillPrice: 100, baselineStopLoss: 90, priceTarget: 120, atr14AtDecision: 2,
    };
    const step = input({ entries: [entry], bars: [{ symbol: "ABC", open: 103, high: 107, low: 102, close: 106 }, { symbol: "XYZ", open: 100, high: 100, low: 100, close: 100 }] });
    const adapted = atrStopStepToPortfolioEvents({ step, result: advanceAtrStopReplaySession(step) });
    expect(adapted.decisionIds).toEqual(["decision-1"]);
    expect(adapted.events[0]).toMatchObject({ id: "decision-1", decisionId: "decision-1", kind: "entry", costPct: 0 });
  });

  it("refuses corporate-action windows and interleaved same-session cash ordering", () => {
    const withDividend = input({ corporateActions: [{ symbol: "ABC", session: "2026-09-28", type: "dividend", dividendPerShare: 1 }] });
    expect(() => atrStopStepToPortfolioEvents({ step: withDividend, result: advanceAtrStopReplaySession(withDividend) }))
      .toThrow("does not yet model split/dividend");

    const entries = ["XYZ", "QRS"].map((symbol, index) => ({
      decisionId: `decision-${index + 1}`, symbol, session: "2026-09-28", filledAt: index === 0 ? "2026-09-28T15:00:00.000Z" : "2026-09-28T18:00:00.000Z",
      quantity: 1, fillPrice: 100, baselineStopLoss: 90, priceTarget: 120, atr14AtDecision: 2,
    }));
    const interleaved = input({ entries, bars: [{ symbol: "ABC", open: 103, high: 107, low: 102, close: 106 }, { symbol: "XYZ", open: 100, high: 100, low: 100, close: 100 }, { symbol: "QRS", open: 100, high: 100, low: 100, close: 100 }],
      externalExits: [{ symbol: "ABC", quantity: 1, fillPrice: 105, filledAt: "2026-09-28T16:30:00.000Z", reason: "manual" }] });
    expect(() => atrStopStepToPortfolioEvents({ step: interleaved, result: advanceAtrStopReplaySession(interleaved) }))
      .toThrow("interleave same-session entries");
  });
});
