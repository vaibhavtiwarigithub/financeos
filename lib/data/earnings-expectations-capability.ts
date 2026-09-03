// Stage 0 only: deterministic coverage analysis for Alpha Vantage's
// EARNINGS_ESTIMATES response. This module does not persist estimates, compute
// a signal, or participate in scoring/trading.

export const EARNINGS_EXPECTATIONS_STAGE0_VERSION = "earnings-expectations-stage0-v1";
export const EARNINGS_EXPECTATIONS_CONTRACT_VERSION = "alpha-vantage-earnings-estimates-v1";
export const EARNINGS_EXPECTATIONS_CONFIRMATION = "RUN_BOUNDED_STAGE0";
export const EARNINGS_EXPECTATIONS_MAX_SYMBOLS = 6;

export type MarketCapTier = "mega" | "large" | "mid" | "small" | "micro" | "unknown";

export interface CapabilityUniverseRow {
  symbol: string;
  market_cap_tier: string | null;
}

export interface CapabilitySymbolResult {
  symbol: string;
  market_cap_tier: MarketCapTier;
  outcome: "cache_hit" | "provider_success" | "unavailable" | "skipped_no_budget";
  estimate_rows: number;
  forward_estimate_rows: number;
  future_quarter_rows: number;
  future_year_rows: number;
  has_q_plus_2: boolean;
  eps_average_rows: number;
  revenue_average_rows: number;
  eps_analyst_count_rows: number;
  revenue_analyst_count_rows: number;
  eps_revision_history_rows: number;
  unknown_basis_rows: number;
  caveats: string[];
}

const TIERS: MarketCapTier[] = ["mega", "large", "mid", "small", "micro", "unknown"];

function tierOf(value: string | null): MarketCapTier {
  return TIERS.includes(value as MarketCapTier) ? value as MarketCapTier : "unknown";
}

function finite(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

function rowsOf(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") return [];
  const estimates = (payload as { estimates?: unknown }).estimates;
  return Array.isArray(estimates)
    ? estimates.filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    : [];
}

export function selectStratifiedCapabilitySample(
  rows: CapabilityUniverseRow[],
  limit: number,
): Array<{ symbol: string; market_cap_tier: MarketCapTier }> {
  const safeLimit = Math.max(0, Math.min(Math.floor(limit), EARNINGS_EXPECTATIONS_MAX_SYMBOLS));
  const unique = new Map<string, MarketCapTier>();
  for (const row of rows) {
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    if (symbol && !unique.has(symbol)) unique.set(symbol, tierOf(row.market_cap_tier));
  }

  const buckets = new Map(TIERS.map((tier) => [tier, [] as string[]]));
  for (const [symbol, tier] of unique) buckets.get(tier)!.push(symbol);
  for (const symbols of buckets.values()) symbols.sort();

  const selected: Array<{ symbol: string; market_cap_tier: MarketCapTier }> = [];
  for (let index = 0; selected.length < safeLimit; index++) {
    let added = false;
    for (const tier of TIERS) {
      const symbol = buckets.get(tier)![index];
      if (!symbol) continue;
      selected.push({ symbol, market_cap_tier: tier });
      added = true;
      if (selected.length === safeLimit) break;
    }
    if (!added) break;
  }
  return selected;
}

export function analyzeEarningsEstimatesPayload(args: {
  symbol: string;
  marketCapTier: MarketCapTier;
  payload: unknown;
  outcome: CapabilitySymbolResult["outcome"];
  asOf: string;
}): CapabilitySymbolResult {
  const rows = rowsOf(args.payload);
  const asOfTime = Date.parse(`${args.asOf.slice(0, 10)}T23:59:59Z`);
  const futureQuarters = rows
    .filter((row) => row.horizon === "fiscal quarter" && Date.parse(`${String(row.date)}T00:00:00Z`) > asOfTime)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const futureYears = rows.filter(
    (row) => row.horizon === "fiscal year" && Date.parse(`${String(row.date)}T00:00:00Z`) > asOfTime,
  );
  const forwardRows = [...futureQuarters, ...futureYears];
  const revisionFields = [
    "eps_estimate_average_7_days_ago",
    "eps_estimate_average_30_days_ago",
    "eps_estimate_average_60_days_ago",
    "eps_estimate_average_90_days_ago",
    "eps_estimate_revision_up_trailing_7_days",
    "eps_estimate_revision_down_trailing_7_days",
    "eps_estimate_revision_up_trailing_30_days",
    "eps_estimate_revision_down_trailing_30_days",
  ];

  const caveats = [
    "Alpha Vantage does not identify GAAP versus adjusted estimate basis; every row remains unknown-basis.",
    "Provider-reported 7/30/60/90-day fields are observed now and are not Kairos historical vintages.",
  ];
  if (!rows.length) caveats.push("No estimates array was returned; coverage is unavailable, not zero.");

  return {
    symbol: args.symbol,
    market_cap_tier: args.marketCapTier,
    outcome: args.outcome,
    estimate_rows: rows.length,
    forward_estimate_rows: forwardRows.length,
    future_quarter_rows: futureQuarters.length,
    future_year_rows: futureYears.length,
    has_q_plus_2: futureQuarters.length >= 2,
    eps_average_rows: forwardRows.filter((row) => finite(row.eps_estimate_average)).length,
    revenue_average_rows: forwardRows.filter((row) => finite(row.revenue_estimate_average)).length,
    eps_analyst_count_rows: forwardRows.filter((row) => finite(row.eps_estimate_analyst_count)).length,
    revenue_analyst_count_rows: forwardRows.filter((row) => finite(row.revenue_estimate_analyst_count)).length,
    eps_revision_history_rows: forwardRows.filter((row) => revisionFields.some((field) => finite(row[field]))).length,
    unknown_basis_rows: forwardRows.length,
    caveats,
  };
}

export function summarizeCapabilityResults(results: CapabilitySymbolResult[]) {
  const measured = results.filter((row) => row.forward_estimate_rows > 0);
  const byTier: Record<string, { sampled: number; with_estimates: number; with_q_plus_2: number }> = {};
  for (const row of results) {
    byTier[row.market_cap_tier] ??= { sampled: 0, with_estimates: 0, with_q_plus_2: 0 };
    byTier[row.market_cap_tier].sampled++;
    if (row.forward_estimate_rows > 0) byTier[row.market_cap_tier].with_estimates++;
    if (row.has_q_plus_2) byTier[row.market_cap_tier].with_q_plus_2++;
  }
  return {
    sampled_symbols: results.length,
    symbols_with_estimates: measured.length,
    coverage_pct: results.length ? Math.round((measured.length / results.length) * 1000) / 10 : null,
    symbols_with_q_plus_2: results.filter((row) => row.has_q_plus_2).length,
    provider_successes: results.filter((row) => row.outcome === "provider_success").length,
    cache_hits: results.filter((row) => row.outcome === "cache_hit").length,
    unavailable: results.filter((row) => row.outcome === "unavailable").length,
    skipped_no_budget: results.filter((row) => row.outcome === "skipped_no_budget").length,
    by_market_cap_tier: byTier,
  };
}

export function capacityScenarios(universeSize: number, dailyBudget: number) {
  const sizes = [...new Set([20, 40, 60, Math.max(0, Math.floor(universeSize))])].filter((n) => n > 0);
  return sizes.map((symbols) => ({
    symbols,
    worst_case_fresh_calls: symbols,
    theoretical_full_budget_days: dailyBudget > 0 ? Math.ceil(symbols / dailyBudget) : null,
    note: "Worst case assumes no cache hits and no quota reserved for existing production workloads.",
  }));
}
