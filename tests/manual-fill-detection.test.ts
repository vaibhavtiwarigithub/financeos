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

  it("records partial and full exits so the observed baseline cannot drift", () => {
    const partial = detectManualFills(
      ACCOUNT,
      [{ symbol: "AAPL", qty: 4, currentPrice: 200, costBasis: 800 }],
      new Map([["AAPL", 10]]),
      [],
      10,
    );
    expect(partial.rowsToInsert).toHaveLength(1);
    expect(partial.rowsToInsert[0]).toMatchObject({ symbol: "AAPL", qty: 4, delta_qty: -6, transition_side: "sell", source: "manual", suggested_stop_price: null });

    // Full exit: symbol no longer held at all.
    const full = detectManualFills(ACCOUNT, [], new Map([["AAPL", 10]]), [], 10);
    expect(full.rowsToInsert).toHaveLength(1);
    expect(full.rowsToInsert[0]).toMatchObject({ symbol: "AAPL", qty: 0, source: "manual", suggested_stop_price: null });
    expect(full.manualDetections).toHaveLength(0); // exits never suggest a stop
  });

  it("does not fabricate cost basis or a stop when broker cost basis is missing", () => {
    const { rowsToInsert } = detectManualFills(
      ACCOUNT,
      [{ symbol: "INTC", qty: 50, currentPrice: 24.10, costBasis: null }],
      new Map(),
      [],
      10,
    );
    expect(rowsToInsert[0].avg_cost).toBeNull();
    expect(rowsToInsert[0].suggested_stop_price).toBeNull();
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

  it("bootstraps existing holdings without calling them manual fills", () => {
    const r = detectManualFills(
      ACCOUNT,
      [{ symbol: "INTC", qty: 50, currentPrice: 24, costBasis: 1200 }],
      new Map(), [], 10, true,
    );
    expect(r.rowsToInsert).toHaveLength(1);
    expect(r.rowsToInsert[0]).toMatchObject({ source: "baseline", transition_side: "baseline", delta_qty: 50 });
    expect(r.manualDetections).toHaveLength(0);
  });

  it("matches several Kairos fills only when their aggregate equals the transition", () => {
    const orders: RecentOrderInput[] = [
      { id: 7, symbol: "AAPL", side: "buy", filledQty: 4 },
      { id: 8, symbol: "AAPL", side: "buy", filledQty: 6 },
    ];
    const r = detectManualFills(ACCOUNT, [{ symbol: "AAPL", qty: 15, currentPrice: 200, costBasis: 3000 }], new Map([["AAPL", 5]]), orders, 10);
    expect(r.rowsToInsert[0]).toMatchObject({ source: "agentic", matched_broker_order_id: null, matched_broker_order_ids: [7, 8] });
  });

  it("refuses to guess attribution when recent fills do not equal the transition", () => {
    const orders: RecentOrderInput[] = [{ id: 7, symbol: "AAPL", side: "buy", filledQty: 4 }];
    const r = detectManualFills(ACCOUNT, [{ symbol: "AAPL", qty: 15, currentPrice: 200, costBasis: 3000 }], new Map([["AAPL", 5]]), orders, 10);
    expect(r.rowsToInsert[0].source).toBe("unknown");
    expect(r.manualDetections).toHaveLength(0);
  });
});
