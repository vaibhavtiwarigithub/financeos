import { describe, expect, it } from "vitest";
import { indiaGttCoverage } from "@/lib/trading/india-gtt-coverage";

const holding = { symbol: "INFY.NS", qty: 10 };
const gtt = (overrides: Record<string, unknown> = {}) => ({
  id: 77, status: "active", expires_at: "2027-01-01T00:00:00Z",
  condition: { tradingsymbol: "INFY", trigger_values: [1400, 1800] },
  orders: [
    { transaction_type: "SELL", quantity: 10, order_type: "LIMIT", price: 1400 },
    { transaction_type: "SELL", quantity: 10, order_type: "LIMIT", price: 1800 },
  ],
  ...overrides,
});

describe("indiaGttCoverage", () => {
  it("recognizes one active two-leg GTT as full coverage without double-counting OCO legs", () => {
    expect(indiaGttCoverage(holding, [gtt() as any])).toMatchObject({ state: "covered", protectedQty: 10, stopPrice: 1400, targetPrice: 1800 });
  });

  it("does not call an expired/cancelled trigger protection", () => {
    expect(indiaGttCoverage(holding, [gtt({ status: "cancelled" }) as any]).state).toBe("unprotected");
  });

  it("flags partial and excessive sell quantities", () => {
    expect(indiaGttCoverage(holding, [gtt({ orders: [{ transaction_type: "SELL", quantity: 5, order_type: "LIMIT", price: 1400 }] }) as any]).state).toBe("partial");
    expect(indiaGttCoverage(holding, [gtt({ orders: [{ transaction_type: "SELL", quantity: 11, order_type: "LIMIT", price: 1400 }] }) as any]).state).toBe("overcovered");
  });

  it("requires reconciliation for multiple active triggers or mismatched OCO legs", () => {
    expect(indiaGttCoverage(holding, [gtt() as any, gtt({ id: 78 }) as any]).state).toBe("review");
    expect(indiaGttCoverage(holding, [gtt({ orders: [{ transaction_type: "SELL", quantity: 10 }, { transaction_type: "SELL", quantity: 9 }] }) as any]).state).toBe("review");
  });

  it("does not call an active but expired GTT protection", () => {
    expect(indiaGttCoverage(holding, [gtt({ expires_at: "2000-01-01T00:00:00Z" }) as any]).state).toBe("review");
  });

  it("requires Kite's expected LIMIT child order type", () => {
    expect(indiaGttCoverage(holding, [gtt({ orders: [{ transaction_type: "SELL", quantity: 10, order_type: "MARKET" }] }) as any]).state).toBe("review");
  });

  it("does not treat a GTT with no sell leg as protective", () => {
    expect(indiaGttCoverage(holding, [gtt({ orders: [{ transaction_type: "BUY", quantity: 10 }] }) as any]).state).toBe("unprotected");
  });
});
