import { describe, expect, it } from "vitest";
import { defaultAttribution, validateAttributionRow, type UpgradePathAttributionRow } from "@/lib/shadows/attribution";

const measured: UpgradePathAttributionRow = {
  program_id: "exit-geometry", market: "us", program_version: "exit-v2", baseline_version: "exit-v1",
  comparison_type: "matched_replay", state: "measured", as_of_session: "2026-09-18",
  window_start: "2026-08-01", window_end: "2026-09-17", baseline_portfolio_return_pct: 2,
  variant_portfolio_return_pct: 2.5, benchmark_return_pct: 1.2, incremental_return_pct: 0.5,
  net_incremental_return_pct: 0.42, benchmark_relative_incremental_return_pct: 0.5,
  drawdown_delta_pct: -0.3, turnover_pct: 11, independent_sessions: 12, ci_lower_pct: 0.1,
  ci_upper_pct: 0.8, t_statistic: 2.1, matched_population_hash: "population-sha", input_snapshot_hash: "input-sha",
  cost_model_version: "cost-v1", validity_reason: null,
  constraints: { same_market: true, same_window: true, same_population: true, non_overlapping_sessions: true, cost_basis: "net" },
};

describe("upgrade path attribution contract", () => {
  it("accepts a fully matched, net-of-cost result", () => expect(validateAttributionRow(measured)).toEqual({ valid: true, reasons: [] }));

  it("rejects arithmetic drift and a gross/net reversal", () => {
    const result = validateAttributionRow({ ...measured, incremental_return_pct: 0.7, net_incremental_return_pct: 0.8 });
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("variant minus baseline");
    expect(result.reasons.join(" ")).toContain("Net incremental");
  });

  it("rejects a headline return without provenance, costs, benchmark, interval, or independent dates", () => {
    const result = validateAttributionRow({ ...measured, matched_population_hash: null, input_snapshot_hash: null, cost_model_version: null, benchmark_return_pct: null, ci_lower_pct: null, independent_sessions: 0 });
    expect(result.valid).toBe(false);
    expect(result.reasons).toHaveLength(5);
  });

  it("never makes operational work pretend to be a portfolio counterfactual", () => {
    expect(defaultAttribution("operational_only").state).toBe("not_attributable");
    expect(validateAttributionRow({ ...measured, comparison_type: "operational_only" }).valid).toBe(false);
  });

  it("rejects a result whose common-market, population, window, or independence attestation is missing", () => {
    const result = validateAttributionRow({ ...measured, constraints: {} });
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("same-market");
  });
});
