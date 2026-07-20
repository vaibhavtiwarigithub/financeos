import { describe, expect, it } from "vitest";
import { currentPaperTradePnl } from "@/lib/paper-current-pnl";

describe("currentPaperTradePnl", () => {
  const position = { market: "us", symbol: "ABC", current_price: 110, updated_at: "2026-07-20T20:00:00Z" };

  it("marks an open buy lot from the same-market position", () => {
    expect(currentPaperTradePnl({ market: "us", symbol: "ABC", order_side: "buy", qty: 2, fill_price: 100, closed_at: null, outcome: null }, [position], "us"))
      .toMatchObject({ amount: 20, pct: 10, currentPrice: 110 });
  });

  it("does not cross markets or invent a mark", () => {
    const trade = { market: "india", symbol: "ABC", order_side: "buy", qty: 2, fill_price: 100, closed_at: null, outcome: null };
    expect(currentPaperTradePnl(trade, [position], "india")).toBeNull();
    expect(currentPaperTradePnl({ ...trade, market: "us" }, [{ ...position, current_price: null }], "us")).toBeNull();
  });

  it("never reports current P&L for closed or sell rows", () => {
    const open = { market: "us", symbol: "ABC", order_side: "buy", qty: 2, fill_price: 100, closed_at: null, outcome: null };
    expect(currentPaperTradePnl({ ...open, closed_at: "2026-07-20T20:00:00Z" }, [position], "us")).toBeNull();
    expect(currentPaperTradePnl({ ...open, order_side: "sell" }, [position], "us")).toBeNull();
  });
});
