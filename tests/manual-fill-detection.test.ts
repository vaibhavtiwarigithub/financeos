import { describe, it, expect } from "vitest";
import { detectManualFills, type RecentOrderInput } from "@/lib/trading/manual-fill-detection";

const ACCOUNT = "605420660";

describe("detectManualFills", () => {
  it("tags a new position with no matching order as manual and suggests a stop", () => {
    const { rowsToInsert, manualDetections } = detectManualFills(
      ACCOUNT,
      [{ symbol: "INTC", qty: 50, currentPrice: 24.10, costBasis: 1205 }], // avg cost 24.10
      new Map(), // nothing known yet
      [],
      10, // 10% stop
    );
    expect(rowsToInsert).toHaveLength(1);
    expect(rowsToInsert[0].source).toBe("manual");
    expect(rowsToInsert[0].suggested_stop_price).toBeCloseTo(24.10 * 0.9, 2);
    expect(manualDetections).toHaveLength(1);
    expect(manualDetections[0]).toEqual({ symbol: "INTC", qty: 50, suggestedStop: rowsToInsert[0].suggested_stop_price });
  });

  it("tags an increase matching a Kairos-placed buy as agentic, no stop suggested", () => {
    const orders: RecentOrderInput[] = [{ id: 7, symbol: "AAPL", side: "buy", filledQty: 10 }];
    const { rowsToInsert, manualDetections } = detectManualFills(
      ACCOUNT,
      [{ symbol: "AAPL", qty: 10, currentPrice: 200, costBasis: 2000 }],
      new Map(),
      orders,
      10,
    );
    expect(rowsToInsert[0].source).toBe("agentic");
    expect(rowsToInsert[0].matched_broker_order_id).toBe(7);
    expect(rowsToInsert[0].suggested_stop_price).toBeNull();
    expect(manualDetections).toHaveLength(0);
  });

  it("a qty match on the WRONG symbol does not count as agentic", () => {
    const orders: RecentOrderInput[] = [{ id: 7, symbol: "MSFT", side: "buy", filledQty: 10 }];
    const { rowsToInsert } = detectManualFills(
      ACCOUNT,
      [{ symbol: "AAPL", qty: 10, currentPrice: 200, costBasis: 2000 }],
      new Map(),
      orders,
      10,
    );
    expect(rowsToInsert[0].source).toBe("manual");
  });

  it("a sell-side order does not match a buy-side increase", () => {
    const orders: RecentOrderInput[] = [{ id: 7, symbol: "AAPL", side: "sell", filledQty: 10 }];
    const { rowsToInsert } = detectManualFills(
      ACCOUNT,
      [{ symbol: "AAPL", qty: 10, currentPrice: 200, costBasis: 2000 }],
      new Map(),
      orders,
      10,
    );
    expect(rowsToInsert[0].source).toBe("manual");
  });

  it("no change (same qty as last known) produces no row", () => {
    const { rowsToInsert, manualDetections } = detectManualFills(
      ACCOUNT,
      [{ symbol: "AAPL", qty: 10, currentPrice: 200, costBasis: 2000 }],
      new Map([["AAPL", 10]]),
      [],
      10,
    );
    expect(rowsToInsert).toHaveLength(0);
    expect(manualDetections).toHaveLength(0);
  });

  it("a decrease (partial or full exit) is out of scope — no stop, ledger row records it if fully closed", () => {
    // Partial exit: still held, smaller qty. Not this route's job (Section 2.5) — no row.
    const partial = detectManualFills(
      ACCOUNT,
      [{ symbol: "AAPL", qty: 4, currentPrice: 200, costBasis: 800 }],
      new Map([["AAPL", 10]]),
      [],
      10,
    );
    expect(partial.rowsToInsert).toHaveLength(0);

    // Full exit: symbol no longer held at all.
    const full = detectManualFills(ACCOUNT, [], new Map([["AAPL", 10]]), [], 10);
    expect(full.rowsToInsert).toHaveLength(1);
    expect(full.rowsToInsert[0]).toMatchObject({ symbol: "AAPL", qty: 0, source: "manual", suggested_stop_price: null });
    expect(full.manualDetections).toHaveLength(0); // exits never suggest a stop
  });

  it("falls back to currentPrice as avg cost when costBasis is missing", () => {
    const { rowsToInsert } = detectManualFills(
      ACCOUNT,
      [{ symbol: "INTC", qty: 50, currentPrice: 24.10, costBasis: null }],
      new Map(),
      [],
      10,
    );
    expect(rowsToInsert[0].avg_cost).toBe(24.10);
    expect(rowsToInsert[0].suggested_stop_price).toBeCloseTo(24.10 * 0.9, 2);
  });

  it("handles multiple simultaneous manual fills independently", () => {
    const { manualDetections } = detectManualFills(
      ACCOUNT,
      [
        { symbol: "INTC", qty: 50, currentPrice: 24, costBasis: 1200 },
        { symbol: "AMD", qty: 20, currentPrice: 100, costBasis: 2000 },
      ],
      new Map(),
      [],
      10,
    );
    expect(manualDetections.map(d => d.symbol).sort()).toEqual(["AMD", "INTC"]);
  });
});
