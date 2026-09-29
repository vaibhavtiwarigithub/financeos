import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("chart-pattern shadow integration contract", () => {
  const research = readFileSync("lib/research-agent.ts", "utf8");
  const route = readFileSync("app/api/agents/chart-pattern-shadow/route.ts", "utf8");
  const migration = readFileSync("supabase/migrations/20260929215738_chart_pattern_shadow_runs.sql", "utf8");

  it("writes only alongside eligible-long decisions and reuses existing candles", () => {
    expect(research).toContain("isEntryCandidateLong({");
    expect(research).toContain("detectConfirmedDoubleReversal(candles)");
    expect(research).toContain("candle_source: candleResult.source");
    expect(research).not.toContain("fetchChartPattern");
  });

  it("reports owner-only, market-local, bounded evidence with shared cohort predicate", () => {
    expect(route).toContain("requireOwner()");
    expect(route).toContain("market !== \"us\" && market !== \"india\"");
    expect(route).toContain("isEntryCandidateLong({");
    expect(route).toContain("no verdict computed");
    expect(route).toContain("observation_labels(horizon_days,benchmark_neutral_return,matured_at)");
    expect(route).toContain("benchmark_price_observations");
    expect(route).toContain("latestBySymbolSession");
  });

  it("exposes per-symbol shadow provenance without presenting it as a score", () => {
    const page = readFileSync("app/dashboard/research/[symbol]/page.tsx", "utf8");
    expect(route).toContain('searchParams.get("symbol")');
    expect(route).toContain("latestAttempt");
    expect(route).toContain('influence: "measure_only"');
    expect(page).toContain("Technical · Candle-pattern evidence");
    expect(page).toContain("does not add points to");
    expect(page).toContain("change the composite score or trades");
    expect(page).toContain("Technical · Candle-pattern evidence");
    expect(page).toContain("This is not a “no pattern” result");
  });

  it("keeps schema writes append-only and denies client mutation", () => {
    expect(migration).toContain("unique (decision_observation_id)");
    expect(migration).toContain("before update or delete");
    expect(migration).toContain("before truncate");
    expect(migration).toContain("revoke update, delete, truncate on public.chart_pattern_shadow_runs from service_role");
    expect(migration).toContain("grant select, insert on public.chart_pattern_shadow_runs to service_role");
    expect(migration).toContain("auth.jwt()) ->> 'email') = 'vterminater@gmail.com'");
  });
});
