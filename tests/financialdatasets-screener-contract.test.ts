import { describe, expect, it } from "vitest";
import {
  FD_SCREENER_FIELD,
  FINANCIAL_DATASETS_SCREENER_URL,
  financialDatasetsScreenerRows,
  normalizeFinancialDatasetsScreenerFilters,
} from "@/lib/data/financialdatasets-screener";

describe("Financial Datasets screener contract", () => {
  it("uses the current statement-search endpoint and field names", () => {
    expect(FINANCIAL_DATASETS_SCREENER_URL).toBe("https://api.financialdatasets.ai/financials/search/screener");
    expect(FD_SCREENER_FIELD.priceToEarnings).toBe("price_to_earnings_ratio");
  });

  it("accepts the current search_results response shape without trusting legacy shapes", () => {
    expect(financialDatasetsScreenerRows({ search_results: [{ ticker: "MSFT" }] })).toEqual([{ ticker: "MSFT" }]);
    expect(financialDatasetsScreenerRows({})).toEqual([]);
  });

  it("keeps manual strategy templates compatible with the provider field rename", () => {
    expect(normalizeFinancialDatasetsScreenerFilters([
      { field: "pe_ratio", operator: "lt", value: 20 },
      { field: "profit_margin", operator: "gt", value: 0.1 },
    ])).toEqual([
      { field: "price_to_earnings_ratio", operator: "lt", value: 20 },
      { field: "net_margin", operator: "gt", value: 0.1 },
    ]);
  });
});
