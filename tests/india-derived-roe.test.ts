import { describe, expect, it } from "vitest";
import { deriveReturnOnEquity } from "@/lib/india-data";

describe("deriveReturnOnEquity", () => {
  it("matches the values measured from Yahoo for names with an empty returnOnEquity", () => {
    // GARUDA.NS 2026-09-28: 30%; TSFINV.NS: 8%; SDBL.NS: loss-making.
    expect(deriveReturnOnEquity({ netIncomeToCommon: 1360384000, bookValue: 48.988, sharesOutstanding: 93041742 })).toBeCloseTo(0.2985, 3);
    expect(deriveReturnOnEquity({ netIncomeToCommon: 4952813056, bookValue: 271.631, sharesOutstanding: 220691838 })).toBeCloseTo(0.0826, 3);
    expect(deriveReturnOnEquity({ netIncomeToCommon: -303872000, bookValue: 37.767, sharesOutstanding: 207901312 })!).toBeLessThan(0);
  });

  it("returns null rather than guessing when an input is missing, non-numeric or the equity is not positive", () => {
    expect(deriveReturnOnEquity({ netIncomeToCommon: 1e9, bookValue: 10, sharesOutstanding: undefined })).toBeNull();
    expect(deriveReturnOnEquity({ netIncomeToCommon: {}, bookValue: 10, sharesOutstanding: 1e6 })).toBeNull();
    expect(deriveReturnOnEquity({ netIncomeToCommon: 1e9, bookValue: -5, sharesOutstanding: 1e6 })).toBeNull();
    expect(deriveReturnOnEquity({ netIncomeToCommon: 1e9, bookValue: 0, sharesOutstanding: 1e6 })).toBeNull();
    expect(deriveReturnOnEquity({ netIncomeToCommon: NaN, bookValue: 10, sharesOutstanding: 1e6 })).toBeNull();
  });

  it("rejects implausible values from a near-zero equity base", () => {
    expect(deriveReturnOnEquity({ netIncomeToCommon: 1e9, bookValue: 0.0001, sharesOutstanding: 1e5 })).toBeNull();
  });
});
