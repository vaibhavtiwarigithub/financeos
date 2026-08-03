// Official Financial Datasets OpenAPI contract as of 2026-08-03.
// The former /stocks/screener/ endpoint returns 404; the provider now exposes
// statement-backed screening at /financials/search/screener.

export const FINANCIAL_DATASETS_SCREENER_URL =
  "https://api.financialdatasets.ai/financials/search/screener";

export const FD_SCREENER_FIELD = {
  revenueGrowth: "revenue_growth",
  earningsGrowth: "earnings_growth",
  grossMargin: "gross_margin",
  returnOnEquity: "return_on_equity",
  marketCap: "market_cap",
  priceToEarnings: "price_to_earnings_ratio",
  freeCashFlowYield: "free_cash_flow_yield",
  debtToEquity: "debt_to_equity",
} as const;

const LEGACY_FIELD_ALIASES: Record<string, string> = {
  pe_ratio: FD_SCREENER_FIELD.priceToEarnings,
  profit_margin: "net_margin",
};

export function normalizeFinancialDatasetsScreenerFilters<T extends { field: string }>(filters: readonly T[]): T[] {
  return filters.map((filter) => ({
    ...filter,
    field: LEGACY_FIELD_ALIASES[filter.field] ?? filter.field,
  }));
}

export function financialDatasetsScreenerRows(data: unknown): any[] {
  const value = data as Record<string, unknown> | null;
  const rows = value?.search_results ?? value?.results ?? value?.data ?? value?.stocks;
  return Array.isArray(rows) ? rows : [];
}
