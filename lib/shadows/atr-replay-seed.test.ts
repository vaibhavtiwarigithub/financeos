import { describe, expect, it } from "vitest";
import { buildAtrReplaySeed } from "./atr-replay-seed";

const base = {
  market: "us" as const,
  session: "2026-09-25",
  cashBalance: "50",
  reportedNav: "150",
  positions: [{
    symbol: "ABC", market: "us", position_role: "alpha", qty: "10", avg_cost: "9",
    current_price: "10", stop_loss: "8", initial_stop_loss: "7.5", price_target: null,
    highest_price: "11",
  }],
  openLots: [{
    symbol: "ABC", market: "us", position_role: "alpha", qty: "10", order_side: "buy",
    closed_at: null, partial_exit_lot: true,
  }],
};

describe("buildAtrReplaySeed", () => {
  it("reconciles cash, marked positions, and lots while preserving partial ladder state", () => {
    const result = buildAtrReplaySeed(base);
    expect(result.nav).toBe(150);
    expect(result.book).toMatchObject({
      market: "us", session: "2026-09-25", cash: 50,
      positions: [{ symbol: "ABC", quantity: 10, costBasis: 9, currentStop: 8, initialStopLoss: 7.5, priceTarget: null, highestPrice: 11, partialTaken: true, applyAtrStop: false }],
    });
    expect(result.partialStateBySymbol).toEqual({ ABC: true });
  });

  it("preserves genuinely missing legacy stop/target values as null", () => {
    const result = buildAtrReplaySeed({
      ...base,
      positions: [{ ...base.positions[0], stop_loss: null, initial_stop_loss: null }],
    });
    expect(result.book.positions[0]).toMatchObject({ currentStop: null, initialStopLoss: null, priceTarget: null });
  });

  it("refuses a mismatch between aggregate position quantity and open lots", () => {
    expect(() => buildAtrReplaySeed({
      ...base,
      openLots: [{ ...base.openLots[0], qty: "9" }],
    })).toThrow("Open paper-lot quantity does not reconcile");
  });

  it("refuses open orphan lots and wrong-market lots", () => {
    expect(() => buildAtrReplaySeed({ ...base, positions: [] })).toThrow("no matching aggregate position");
    expect(() => buildAtrReplaySeed({
      ...base,
      openLots: [{ ...base.openLots[0], market: "india" }],
    })).toThrow("not an open long lot in us");
  });

  it("refuses non-reconciled NAV and missing cash instead of coercing null to zero", () => {
    expect(() => buildAtrReplaySeed({ ...base, reportedNav: "151" })).toThrow("does not reconcile to paper NAV");
    expect(() => buildAtrReplaySeed({ ...base, cashBalance: null })).toThrow("cash and reported NAV");
  });

  it("requires an observed high-water mark rather than fabricating one", () => {
    expect(() => buildAtrReplaySeed({
      ...base,
      positions: [{ ...base.positions[0], highest_price: null }],
    })).toThrow("high-water mark");
    expect(() => buildAtrReplaySeed({
      ...base,
      positions: [{ ...base.positions[0], highest_price: "9" }],
    })).toThrow("high-water mark");
  });
});
