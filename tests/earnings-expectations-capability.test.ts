import { describe, expect, it } from "vitest";
import {
  analyzeEarningsEstimatesPayload,
  capacityScenarios,
  EARNINGS_EXPECTATIONS_MAX_SYMBOLS,
  selectStratifiedCapabilitySample,
  summarizeCapabilityResults,
} from "@/lib/data/earnings-expectations-capability";

describe("earnings expectations Stage 0 capability probe", () => {
  it("selects deterministically across market-cap tiers and enforces the hard cap", () => {
    const sample = selectStratifiedCapabilitySample([
      { symbol: "ZZZ", market_cap_tier: "mega" },
      { symbol: "AAA", market_cap_tier: "mega" },
      { symbol: "MID", market_cap_tier: "mid" },
      { symbol: "SML", market_cap_tier: "small" },
      { symbol: "MIC", market_cap_tier: "micro" },
      { symbol: "LRG", market_cap_tier: "large" },
      { symbol: "UNK", market_cap_tier: null },
      { symbol: "EXTRA", market_cap_tier: "large" },
    ], 99);

    expect(sample).toHaveLength(EARNINGS_EXPECTATIONS_MAX_SYMBOLS);
    expect(sample.map((row) => row.symbol)).toEqual(["AAA", "EXTRA", "MID", "SML", "MIC", "UNK"]);
  });

  it("detects true future Q+2 coverage without treating old quarters as forward", () => {
    const result = analyzeEarningsEstimatesPayload({
      symbol: "TEST",
      marketCapTier: "small",
      outcome: "provider_success",
      asOf: "2026-09-03",
      payload: {
        estimates: [
          { date: "2026-06-30", horizon: "fiscal quarter", eps_estimate_average: "1" },
          { date: "2026-09-30", horizon: "fiscal quarter", eps_estimate_average: "2", revenue_estimate_average: "10", eps_estimate_analyst_count: "3", eps_estimate_average_30_days_ago: "1.8" },
          { date: "2026-12-31", horizon: "fiscal quarter", eps_estimate_average: "3", revenue_estimate_average: "11", revenue_estimate_analyst_count: "4", eps_estimate_revision_up_trailing_30_days: "2" },
          { date: "2027-12-31", horizon: "fiscal year", eps_estimate_average: "12" },
        ],
      },
    });

    expect(result.future_quarter_rows).toBe(2);
    expect(result.future_year_rows).toBe(1);
    expect(result.forward_estimate_rows).toBe(3);
    expect(result.has_q_plus_2).toBe(true);
    expect(result.unknown_basis_rows).toBe(3);
    expect(result.eps_revision_history_rows).toBe(2);
    expect(result.caveats.join(" ")).toContain("not Kairos historical vintages");
  });

  it("reports missing payloads as unavailable rather than false zero coverage", () => {
    const result = analyzeEarningsEstimatesPayload({
      symbol: "NONE",
      marketCapTier: "micro",
      outcome: "unavailable",
      asOf: "2026-09-03",
      payload: { Information: "unavailable" },
    });
    const summary = summarizeCapabilityResults([result]);
    expect(summary.unavailable).toBe(1);
    expect(summary.coverage_pct).toBe(0);
    expect(result.caveats.join(" ")).toContain("unavailable, not zero");
  });

  it("keeps capacity math explicitly theoretical and quota bounded", () => {
    expect(capacityScenarios(187, 25)).toEqual([
      expect.objectContaining({ symbols: 20, theoretical_full_budget_days: 1 }),
      expect.objectContaining({ symbols: 40, theoretical_full_budget_days: 2 }),
      expect.objectContaining({ symbols: 60, theoretical_full_budget_days: 3 }),
      expect.objectContaining({ symbols: 187, theoretical_full_budget_days: 8 }),
    ]);
  });
});
