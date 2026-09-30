import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const route = readFileSync("app/api/agents/benchmark-scorecard/route.ts", "utf8");
const migration = readFileSync("supabase/migrations/20260915130000_market_local_benchmark_collectors.sql", "utf8");
const scorecard = readFileSync("components/dashboard/AlphaScorecard.tsx", "utf8");
const performanceSeries = readFileSync("app/api/portfolio/performance-series/route.ts", "utf8");

describe("market-local benchmark collector", () => {
  it("refuses an unscoped collector call", () => {
    expect(route).toContain('market=us|india is required; collectors are intentionally market-local');
  });

  it("records the market from the request, never a hard-coded US market", () => {
    expect(route).toContain("market: marketScope");
    expect(route).not.toContain('agent_type: "benchmark_scorecard", market: "us"');
  });

  it("defines done by every enabled benchmark reaching the expected session", () => {
    expect(route).toContain("expectedLatestSessionDate(marketScope)");
    expect(route).toContain("verifyMarketCompletion");
    expect(route).toContain('observedSession === expectedSession && sourceStatus === "ok"');
    expect(route).toContain('completion.length > 0 && incomplete.length === 0 ? "done" : "partial"');
  });

  it("uses paginated clean EOD paper marks instead of a fixed-size mixed snapshot slice", () => {
    expect(route).toContain("canonicalPortfolioSnapshots");
    expect(route).toContain('.eq("snapshot_type", "eod")');
    expect(route).toContain('.eq("tainted", false)');
    expect(route).toContain("fetchAllRows");
    expect(route).not.toContain('.limit(500);');
  });

  it("reads only the selected benchmark's configured component symbol", () => {
    expect(performanceSeries).toContain('.eq("component_symbol", selected.provider_symbol ?? selected.symbol ?? selected.label)');
  });

  it("makes the retry and per-benchmark diagnostic durable", () => {
    expect(route).toContain('const attempt = url.searchParams.get("attempt") === "retry" ? "retry" : "initial"');
    expect(route).toContain("provider=${row.provider ?? \"none\"}");
    expect(route).toContain("expected=${row.expected_session}");
    expect(route).toContain("observed=${row.observed_session ?? \"none\"}");
    expect(route).toContain("benchmark-collector-freshness:${marketScope}");
  });

  it("schedules initial and bounded retry slots for each market", () => {
    for (const name of [
      "india-initial", "india-retry", "us-initial-dst", "us-initial-standard", "us-retry-dst", "us-retry-standard",
    ]) expect(migration).toContain(`kairos-benchmark-scorecard-${name}`);
    expect(migration).toContain("local_slot=15:45");
    expect(migration).toContain("local_slot=16:15");
    expect(migration).toContain("local_slot=16:45");
  });

  it("keeps the owner-triggered UI on the same market-local contract", () => {
    expect(scorecard).toContain("benchmark-scorecard?market=${market}&attempt=initial");
  });
});
