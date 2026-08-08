import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const forecastRoute = readFileSync("app/api/property/forecasts/route.ts", "utf8");
const overviewRoute = readFileSync("app/api/property/overview/route.ts", "utf8");
const evidenceMigration = readFileSync("supabase/migrations/20260807120000_property_private_scenarios_and_learning.sql", "utf8");
const integrityMigration = readFileSync("supabase/migrations/20260807153000_property_forecast_selection_integrity.sql", "utf8");

describe("property forecast data path invariants", () => {
  it("selects newest observations before applying the forecast input limit", () => {
    const inputQuery = forecastRoute.slice(
      forecastRoute.indexOf('from("property_market_observations")'),
      forecastRoute.indexOf("if (observationError)"),
    );
    expect(inputQuery).toContain('.order("as_of", { ascending: false })');
    expect(inputQuery.indexOf('.order("as_of", { ascending: false })'))
      .toBeLessThan(inputQuery.indexOf(".limit(FORECAST_INPUT_QUERY_LIMIT)"));
  });

  it("bounds overview history independently per metric, newest first", () => {
    expect(overviewRoute).toContain("Promise.all(OVERVIEW_METRICS.map");
    expect(overviewRoute).toContain('.eq("metric_key", metric)');
    expect(overviewRoute).toContain('.order("as_of", { ascending: false })');
    expect(overviewRoute).toContain(".limit(OBSERVATIONS_PER_METRIC)");
  });

  it("freezes actual observation provenance and prevents duplicate forecast identities", () => {
    expect(forecastRoute).toContain("actual_observation_id: actual.id");
    expect(forecastRoute).toContain("source_key: selected.sourceKey");
    expect(forecastRoute).toContain('.eq("source_key", forecast.source_key)');
    expect(integrityMigration).toContain("property_forecasts_identity_key");
    expect(integrityMigration).toContain("property_forecasts_v2_source_required");
    expect(integrityMigration).toContain("actual_observation_id bigint");
  });

  it("keeps forecast evidence append-only at row and statement level", () => {
    expect(evidenceMigration).toContain("'property_scenarios','property_forecasts','property_forecast_outcomes'");
    expect(evidenceMigration).toContain("before update or delete");
    expect(evidenceMigration).toContain("before truncate");
    expect(evidenceMigration).toContain("revoke update, delete, truncate");
    expect(forecastRoute).not.toMatch(/\.update\(|\.delete\(|\.upsert\(/);
  });
});
