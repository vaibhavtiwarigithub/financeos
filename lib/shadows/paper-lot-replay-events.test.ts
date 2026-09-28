import { describe, expect, it } from "vitest";
import { marketSessionDateAt, paperLotReplayEvents, type PaperLotReplayRow } from "./paper-lot-replay-events";

const base = (overrides: Partial<PaperLotReplayRow> = {}): PaperLotReplayRow => ({
  id: "lot-1", market: "us", symbol: "ABC", order_side: "buy", qty: 5,
  fill_price: 100, executed_at: "2026-09-28T15:15:00.000Z", signal_id: "sig-1",
  paper_event_id: 21, position_role: "alpha", stop_loss: 95, take_profit: 120,
  partial_exit_lot: false, ...overrides,
});

describe("paper lot ledger to replay events", () => {
  it("uses exchange-local sessions across US daylight time and India time", () => {
    expect(marketSessionDateAt("2026-09-28T15:15:00.000Z", "us")).toBe("2026-09-28");
    expect(marketSessionDateAt("2026-09-28T04:10:00.000Z", "india")).toBe("2026-09-28");
    expect(marketSessionDateAt("2026-09-29T02:00:00.000Z", "us")).toBe("2026-09-28");
  });

  it("reassembles the original buy quantity across residual lots and keeps the exact partial sale", () => {
    const rows = [
      base({ qty: 3, exit_at: "2026-09-29T20:15:00.000Z", closed_at: "2026-09-29T20:15:00.000Z", exit_price: 108, exit_reason: "capital_rotation" }),
      base({ id: "lot-1-residual", qty: 2, partial_exit_lot: true }),
    ];
    const events = paperLotReplayEvents({
      market: "us", rows, afterSession: "2026-09-25", throughSession: "2026-09-29",
      atr14BySignalId: { "sig-1": 2.5 },
    });

    expect(events.entries).toEqual([{
      decisionId: expect.stringContaining("paper-entry:"), symbol: "ABC", session: "2026-09-28",
      filledAt: "2026-09-28T15:15:00.000Z", quantity: 5, fillPrice: 100,
      baselineStopLoss: 95, priceTarget: 120, atr14AtDecision: 2.5,
    }]);
    expect(events.exits).toEqual([{
      decisionId: "lot-1:exit", symbol: "ABC", session: "2026-09-29",
      quantity: 3, fillPrice: 108, filledAt: "2026-09-29T20:15:00.000Z",
      reason: "capital_rotation", classification: "external",
    }]);
  });

  it("classifies actual stop/target lot closes as mechanical for baseline reconciliation", () => {
    const events = paperLotReplayEvents({
      market: "us",
      rows: [base({ exit_at: "2026-09-29T20:15:00.000Z", exit_price: 95, exit_reason: "stop_hit" })],
      afterSession: "2026-09-25", throughSession: "2026-09-29", atr14BySignalId: { "sig-1": 2 },
    });
    expect(events.exits[0]).toMatchObject({ classification: "mechanical", reason: "stop", quantity: 5, fillPrice: 95 });
  });

  it("fails closed on unknown reasons, legacy time-stop exits, missing risk geometry and unexplained sell rows", () => {
    const input = { market: "us" as const, afterSession: "2026-09-25", throughSession: "2026-09-29", atr14BySignalId: { "sig-1": 2 } };
    expect(() => paperLotReplayEvents({ ...input, rows: [base({ exit_at: "2026-09-29T20:15:00Z", exit_price: 101, exit_reason: "time_stop (legacy)" })] }))
      .toThrow("Unsupported closed-lot exit reason");
    expect(() => paperLotReplayEvents({ ...input, rows: [base({ stop_loss: null })] }))
      .toThrow("lacks one consistent exact stop/target");
    expect(() => paperLotReplayEvents({ ...input, rows: [base({ order_side: "sell" })] }))
      .toThrow("Unexpected order_side=sell");
  });

  it("rejects residual lots whose entry lineage cannot be reconstructed", () => {
    expect(() => paperLotReplayEvents({
      market: "us", afterSession: "2026-09-25", throughSession: "2026-09-29", atr14BySignalId: {},
      rows: [base({ signal_id: null, paper_event_id: null, partial_exit_lot: true })],
    })).toThrow("lacks both signal_id and paper_event_id");
  });
});
