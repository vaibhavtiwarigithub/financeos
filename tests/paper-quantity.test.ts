import { describe, expect, it } from "vitest";
import { paperDailyCapQuantity, paperEntryQuantity, paperPartialTargetQuantity, paperRunnerStopPrice } from "@/lib/trading/paper-quantity";

describe("paperEntryQuantity", () => {
  it("uses six-decimal US fractions without exceeding the allocation", () => {
    const qty = paperEntryQuantity("us", 100, 326.0529);
    expect(qty).toBe(0.306698);
    expect((qty ?? 0) * 326.0529).toBeLessThanOrEqual(100);
  });

  it("keeps India whole-share", () => {
    expect(paperEntryQuantity("india", 100, 326.0529)).toBeNull();
    expect(paperEntryQuantity("india", 1000, 326.0529)).toBe(3);
  });

  it("rejects non-finite or non-positive inputs", () => {
    expect(paperEntryQuantity("us", NaN, 10)).toBeNull();
    expect(paperEntryQuantity("us", 10, 0)).toBeNull();
  });
});

describe("paperDailyCapQuantity", () => {
  it("reduces the SUNTV.NS buy to 192 whole shares under the India daily cap", () => {
    const qty = paperDailyCapQuantity("india", 198, 640.32, 376_827.14, 500_000);
    expect(qty).toBe(192);
    expect(376_827.14 + (qty ?? 0) * 640.32).toBeLessThanOrEqual(500_000);
  });

  it("uses six-decimal US paper shares and never increases an approved quantity", () => {
    const qty = paperDailyCapQuantity("us", 2, 326.0529, 900, 1_000);
    expect(qty).toBe(0.306698);
    expect(900 + (qty ?? 0) * 326.0529).toBeLessThanOrEqual(1_000);
    expect(paperDailyCapQuantity("us", 0.25, 326.0529, 900, 1_000)).toBe(0.25);
  });

  it("refuses zero room, an unbuyable India remainder, or malformed cap evidence", () => {
    expect(paperDailyCapQuantity("india", 198, 640.32, 499_500, 500_000)).toBeNull();
    expect(paperDailyCapQuantity("us", 1, 100, 500_000, 500_000)).toBeNull();
    expect(paperDailyCapQuantity("us", 1, 100, NaN, 500_000)).toBeNull();
    expect(paperDailyCapQuantity("us", 1, 100, -1, 500_000)).toBeNull();
  });
});

describe("paperPartialTargetQuantity", () => {
  it("splits a fractional US holding while preserving a positive remainder", () => {
    expect(paperPartialTargetQuantity("us", 0.306698)).toBe(0.153349);
  });

  it("preserves India's whole-share partial rule", () => {
    expect(paperPartialTargetQuantity("india", 1)).toBeNull();
    expect(paperPartialTargetQuantity("india", 3)).toBe(1);
  });
});

describe("paperRunnerStopPrice", () => {
  it("raises a below-entry trailing stop to breakeven", () => {
    expect(paperRunnerStopPrice(100, 96)).toBe(100);
  });

  it("preserves a trailing stop that already protects profit", () => {
    expect(paperRunnerStopPrice(100, 103.25)).toBe(103.25);
  });
});
