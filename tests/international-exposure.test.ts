import { describe, expect, it } from "vitest";
import { summarizeInternationalExposure } from "@/lib/allocation/international-exposure";

describe("summarizeInternationalExposure", () => {
  it("counts only curated country ETFs and keeps USD book denominator local", () => {
    const result = summarizeInternationalExposure([
      { symbol: "INDA", qty: 10, current_price: 50 },
      { symbol: "AAPL", qty: 5, current_price: 100 },
    ]);

    expect(result.investedValue).toBe(1000);
    expect(result.recognizedInternationalValue).toBe(500);
    expect(result.recognizedInternationalPct).toBe(50);
    expect(result.rows).toMatchObject([{ symbol: "INDA", geography: "India", value: 500, bookPct: 50, valuation: "mark" }]);
  });

  it("refuses to invent geographic exposure for broad or unknown ETFs", () => {
    const result = summarizeInternationalExposure([
      { symbol: "VOO", qty: 2, current_price: 500 },
      { symbol: "VXUS", qty: 3, current_price: 100 },
      { symbol: "AAPL", qty: 1, current_price: 100 },
    ]);

    expect(result.recognizedInternationalValue).toBe(0);
    expect(result.recognizedInternationalPct).toBe(0);
    expect(result.unclassifiedEtfSymbols).toEqual(["VOO"]);
    // VXUS is not in the current static ETF registry. P0 reports no fabricated
    // exposure, which is safer than silently classifying an unreviewed ticker.
    expect(result.rows).toEqual([]);
  });

  it("uses cost only when the current paper mark is unavailable and records it", () => {
    const result = summarizeInternationalExposure([
      { symbol: "EWJ", qty: 4, current_price: null, avg_cost: 25 },
      { symbol: "AAPL", qty: 1, current_price: 100 },
    ]);

    expect(result.rows[0]).toMatchObject({ symbol: "EWJ", value: 100, valuation: "cost", bookPct: 50 });
    expect(result.costValuedSymbols).toEqual(["EWJ"]);
  });

  it("drops malformed positions rather than creating NaN exposure", () => {
    const result = summarizeInternationalExposure([
      { symbol: "INDA", qty: "NaN", current_price: 50 },
      { symbol: "EWJ", qty: 1, current_price: -1, avg_cost: 0 },
    ]);

    expect(result).toMatchObject({ investedValue: 0, recognizedInternationalValue: 0, recognizedInternationalPct: null, rows: [] });
  });
});
