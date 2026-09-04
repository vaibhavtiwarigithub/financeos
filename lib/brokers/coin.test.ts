import { describe, expect, it } from "vitest";
import { buildCoinPortfolio, normalizeCoinHolding } from "@/lib/brokers/coin";

describe("Coin portfolio normalization", () => {
  it("derives valuation and P&L from NAV rather than trusting the provider pnl field", () => {
    expect(normalizeCoinHolding({
      tradingsymbol: "inf123",
      fund: "Example Direct Growth",
      folio: "42",
      quantity: 10,
      average_price: 100,
      last_price: 112,
      last_price_date: "2026-09-02",
      pnl: 0,
    })).toMatchObject({
      isin: "INF123",
      quantity: 10,
      investedValue: 1000,
      currentValue: 1120,
      pnl: 120,
      pnlPct: 12,
    });
  });

  it("rejects rows without a fund identity or positive quantity", () => {
    expect(normalizeCoinHolding({ fund: "Fund", quantity: 2 })).toBeNull();
    expect(normalizeCoinHolding({ tradingsymbol: "INF123", fund: "Fund", quantity: 0 })).toBeNull();
  });

  it("does not turn a missing NAV into a zero-valued portfolio", () => {
    const result = buildCoinPortfolio([
      { tradingsymbol: "INF1", fund: "Fund One", quantity: 2, average_price: 100, last_price: 110 },
      { tradingsymbol: "INF2", fund: "Fund Two", quantity: 3, average_price: 50, last_price: null },
    ]);
    expect(result.valuationComplete).toBe(false);
    expect(result.totalValue).toBeNull();
    expect(result.totalPnl).toBeNull();
    expect(result.holdings[1].currentValue).toBeNull();
  });

  it("distinguishes a successful empty portfolio from unavailable data", () => {
    expect(buildCoinPortfolio([])).toEqual({
      holdings: [],
      holdingCount: 0,
      valuationComplete: true,
      totalInvested: 0,
      totalValue: 0,
      totalPnl: 0,
    });
  });
});
