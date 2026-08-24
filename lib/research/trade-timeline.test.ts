import { describe, expect, it } from "vitest";
import { latestExecutionEvent, liveDecisionEvents, paperTradeEvents } from "./trade-timeline";

describe("paperTradeEvents", () => {
  it("expands a closed long lot into a BUY fill and a later SELL fill", () => {
    const events = paperTradeEvents([{
      id: "lot-1", order_side: "buy", qty: "2", fill_price: "100",
      executed_at: "2026-08-01T14:00:00Z", exit_at: "2026-08-10T14:00:00Z",
      exit_price: "110", realized_pnl_pct: "10", exit_reason: "time_stop",
    }]);
    expect(events.map((event) => [event.side, event.occurred_at])).toEqual([
      ["sell", "2026-08-10T14:00:00Z"],
      ["buy", "2026-08-01T14:00:00Z"],
    ]);
    expect(latestExecutionEvent(events)?.side).toBe("sell");
    expect(events[0]).toMatchObject({ price: 110, qty: 2, realized_pnl_pct: 10, reason: "time_stop" });
  });

  it("does not invent a BUY after an explicit SELL ledger row", () => {
    const events = paperTradeEvents([{
      id: "rotation-sell", order_side: "sell", qty: 3, fill_price: 50,
      executed_at: "2026-08-10T14:00:00Z", closed_at: "2026-08-10T14:00:00Z",
      exit_price: 50,
    }]);
    expect(events).toHaveLength(1);
    expect(events[0].side).toBe("sell");
  });
});

describe("liveDecisionEvents", () => {
  it("keeps a proposal distinct from a broker fill", () => {
    const events = liveDecisionEvents(
      [{ id: 1, side: "sell", qty: 2, status: "approved", created_at: "2026-08-10T13:00:00Z" }],
      [{ id: 2, side: "sell", qty: 2, filled_qty: 2, avg_fill_price: 101, status: "filled", submitted_at: "2026-08-10T13:05:00Z" }],
    );
    expect(events[0]).toMatchObject({ stage: "fill", is_execution: true, side: "sell" });
    expect(events[1]).toMatchObject({ stage: "proposal", is_execution: false, side: "sell" });
  });
});
