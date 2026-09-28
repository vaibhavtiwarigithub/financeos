import { describe, expect, it } from "vitest";
import { advanceAtrStopReplaySession, type AtrStopReplayBook, type AtrStopReplayStepInput } from "@/lib/shadows/atr-stop-forward-replay";
import { runAtrStopPairedPortfolioReplay, type AtrStopPairedReplayInput } from "@/lib/shadows/atr-stop-paired-replay";

const seed: AtrStopReplayBook = { market: "us", session: "2026-09-28", cash: 1000, positions: [] };
const policy = { market: "us" as const, currency: "USD" as const, initialCash: 1000, maxOpenNames: 2, allowFractionalShares: true, initialPositions: [] };

function step(input: Partial<AtrStopReplayStepInput> & Pick<AtrStopReplayStepInput, "arm" | "session" | "book">): AtrStopReplayStepInput {
  return {
    market: "us", priceBasis: "raw_ohlc", bars: [], corporateActions: [], entries: [],
    costs: { version: "sell-slip-5bps-v1", sellCostBps: 5 }, ...input,
  };
}

function pair(): AtrStopPairedReplayInput {
  const entry = { decisionId: "decision-20260929-xyz", symbol: "XYZ", session: "2026-09-29", filledAt: "2026-09-29T15:00:00.000Z",
    quantity: 1, fillPrice: 100, baselineStopLoss: 99, priceTarget: 120, atr14AtDecision: 1 };
  const baselineFirst = step({ arm: "baseline", session: "2026-09-29", book: seed, entries: [entry] });
  const variantFirst = step({ arm: "atr_2_8", session: "2026-09-29", book: seed, entries: [entry] });
  const baselineAfterEntry = advanceAtrStopReplaySession(baselineFirst).book;
  const variantAfterEntry = advanceAtrStopReplaySession(variantFirst).book;
  const barriers = [{ symbol: "XYZ", open: 100, high: 101, low: 98, close: 100 }];
  return {
    market: "us" as const,
    windowStart: "2026-09-28",
    windowEnd: "2026-09-30",
    expectedSessions: ["2026-09-28", "2026-09-29", "2026-09-30"],
    initialBook: seed,
    policy,
    steps: [
      { baseline: baselineFirst, variant: variantFirst },
      {
        baseline: step({ arm: "baseline", session: "2026-09-30", book: baselineAfterEntry, bars: barriers }),
        variant: step({ arm: "atr_2_8", session: "2026-09-30", book: variantAfterEntry, bars: barriers }),
      },
    ],
    marks: [
      { session: "2026-09-28", prices: {}, benchClose: 500 },
      { session: "2026-09-29", prices: { XYZ: 100 }, benchClose: 502 },
      { session: "2026-09-30", prices: { XYZ: 100 }, benchClose: 505 },
    ],
    pointInTimeInputs: { source: "synthetic-test-fixture" },
    independenceBlockSessions: 1,
  };
}

describe("ATR stop paired portfolio producer core", () => {
  it("runs both frozen-seed books through the strict matched portfolio attribution gate", () => {
    const result = runAtrStopPairedPortfolioReplay(pair());
    expect(result.replay.row).toMatchObject({
      program_id: "exit-stop-shadow", market: "us", comparison_type: "matched_replay", state: "measured",
      independent_sessions: 2, baseline_net_portfolio_return_pct: expect.any(Number),
      variant_net_portfolio_return_pct: expect.any(Number),
    });
    expect(result.replay.row.variant_net_portfolio_return_pct).toBeGreaterThan(result.replay.row.baseline_net_portfolio_return_pct!);
    expect(result.diagnostics).toMatchObject({ replayedSessions: 2, entryDecisionCount: 1, baselineExitCount: 1, variantExitCount: 0 });
    expect(result.replay.diagnostics.completeIndependentBlocks).toBe(2);
  });

  it("refuses divergent per-session inputs and a candidate-free interval", () => {
    const mismatched = pair();
    mismatched.steps[1].variant.bars = [{ ...mismatched.steps[1].variant.bars[0], high: 103 }];
    expect(() => runAtrStopPairedPortfolioReplay(mismatched)).toThrow("do not share identical point-in-time inputs");

    const empty = pair();
    empty.steps[0].baseline.entries = [];
    empty.steps[0].variant.entries = [];
    empty.steps[1].baseline.book = { ...seed, session: "2026-09-29" };
    empty.steps[1].variant.book = { ...seed, session: "2026-09-29" };
    expect(() => runAtrStopPairedPortfolioReplay(empty)).toThrow("non-empty unique");
  });
});
