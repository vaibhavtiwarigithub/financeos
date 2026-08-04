import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const route = read("app/api/agents/research/cron/route.ts");

// The discovery-only run exists because screener candidates were structurally
// last in an oversubscribed queue and were never scored — zero screener-sourced
// decisions across all of 2026-07 regardless of whether discovery worked.
describe("research discovery-scope run", () => {
  it("excludes holdings, so it can never touch an exit/SELL path", () => {
    expect(route).toContain("!e.isHeld && DISCOVERY_SOURCES.includes");
  });

  it("selects only never-held discovery buckets", () => {
    for (const src of ["screener_momentum", "screener_value", "india_screener"]) {
      expect(route).toContain(src);
    }
  });

  it("does not resolve the holdings-deferred alert from a discovery run", () => {
    // A discovery run carries no holdings by construction, so an unguarded
    // resolve would clear a real shortfall the main run had just raised —
    // an alert silenced by a run that never looked.
    expect(route).toContain("} else if (!discoveryOnly) {");
  });

  it("scopes alert keys by run type so the two runs cannot fight", () => {
    expect(route).toContain('const runTag = `${marketScope ?? "mixed"}${discoveryOnly ? ":discovery" : ""}`');
    for (const key of [
      "research-deferred-holdings:${runTag}",
      "research-deferred-screener:${runTag}",
      "research-symbol-failures:${runTag}",
    ]) {
      expect(route).toContain(key);
    }
  });

  it("schedules both discovery runs after their market's main run", () => {
    const sql = read("supabase/migrations/20260804060000_research_discovery_run.sql");
    // US main 13:00 -> discovery 14:30; India main 04:00 -> discovery 05:00.
    expect(sql).toContain("'30 14 * * 1-5'");
    expect(sql).toContain("'0 5 * * 1-5'");
    expect(sql).toContain("scope=discovery");
  });
});
