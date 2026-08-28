import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const route = readFileSync("app/api/analytics/alpha-diagnostics/route.ts", "utf8");

describe("Alpha Diagnostic Lab route integrity contract", () => {
  it("runs the eligible-long selection cohort and labels all-scored as context", () => {
    expect(route).toContain('selectionRowsFromObservations(observationRows, A2_HORIZON, "eligible_long")');
    expect(route).toContain('allScored.testId = "A2_ALL_SCORED"');
    expect(route).toContain('cohortDefinition: "all_scored_context"');
  });

  it("queries entry eligibility, excursions, initial stops, and persisted mark quantity", () => {
    expect(route).toContain("analyst_score, entry_eligible, direction");
    expect(route).toContain("max_adverse_excursion, max_favorable_excursion");
    expect(route).toContain('.select("session_date, symbol, qty, mark_price")');
    expect(route).toContain("initial_stop_loss, stop_loss, price_target");
  });

  it("paginates the observation ledger instead of trusting PostgREST's row cap", () => {
    expect(route).toContain("loadAllRows<any>");
    expect(route).toContain(".range(from, to)");
    const observationQuery = route.slice(
      route.indexOf('loadAllRows<any>((from, to) => svc.from("decision_observations")'),
      route.indexOf('// A6 inputs.'),
    );
    expect(observationQuery).not.toContain(".limit(");
  });

  it("starts A6 only from a canonical mark with an untainted performance row", () => {
    expect(route).toContain("cleanPerformanceDates");
    expect(route).toContain("r.tainted !== true");
    expect(route).toContain("allMarks.find(mark => cleanPerformanceDates.has(mark.session))");
  });

  it("never silently substitutes zero for a missing realized outcome", () => {
    expect(route).not.toContain("Number(r.realized_pnl) || 0");
    expect(route).not.toContain("Number(r.pnl_pct) || 0");
    expect(route).toContain("num(r.realized_pnl) ?? Number.NaN");
  });

  it("uses a non-null metric fallback when a deploy SHA is unavailable", () => {
    expect(route).toContain("ALPHA_DIAGNOSTIC_METRIC_VERSION");
    expect(route).toContain("process.env.VERCEL_GIT_COMMIT_SHA ?? ALPHA_DIAGNOSTIC_METRIC_VERSION");
  });
});
