import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ETF_SCORE_CAP, ARCHETYPES, computeArchetypeScore } from "@/lib/scoring/archetypes";

const read = (path: string) => readFileSync(path, "utf8");

describe("research signal regressions", () => {
  it("caps ETF archetype scores at the one canonical cap", () => {
    const etfTrend = ARCHETYPES.find((archetype) => archetype.id === "etf_trend");
    expect(etfTrend).toBeDefined();
    const result = computeArchetypeScore(etfTrend!, {
      fundamental: 100, technical: 100, sentiment: 100, macro: 100, insider: 100,
    }, {
      fundamental: false, technical: true, sentiment: true, macro: true, insider: false,
    });
    expect(ETF_SCORE_CAP).toBe(65);
    expect(result.score).toBe(ETF_SCORE_CAP);
  });

  it("uses the canonical ETF cap in every ResearchAgent score path", () => {
    const source = read("lib/research-agent.ts");
    expect(source).toContain('import { ETF_SCORE_CAP, routeToArchetypes, computeArchetypeScore }');
    expect(source).toContain("Math.min(rawAnalystScore, ETF_SCORE_CAP)");
    expect(source).toContain("Math.min(rawShadow, ETF_SCORE_CAP)");
    expect(source).not.toContain("const ETF_SCORE_CAP = 65");
  });

  it("publishes atomically and never falls back to untagged non-transactional inserts", () => {
    const source = read("lib/research-agent.ts");
    expect(source).toContain('supabase.rpc("publish_research_signal"');
    expect(source).toContain('agent_signals publication failed');
    expect(source).not.toContain('from("agent_signals").insert(signalRow)');
    expect(source).not.toContain('delete signalRow.market');
    const migration = read("supabase/migrations/20261022133418_atomic_research_signal_publish.sql");
    expect(migration.indexOf('pg_advisory_xact_lock')).toBeLessThan(migration.indexOf('update public.agent_signals'));
    expect(migration.indexOf('Research publication deadline expired')).toBeLessThan(migration.indexOf('update public.agent_signals'));
    expect(migration).toContain('security invoker set search_path=pg_catalog,public');
    expect(migration).toContain('from public,anon,authenticated');
  });

  it("reports held-symbol failures as next-pass retries rather than queued candidates", () => {
    const source = read("app/api/agents/research/cron/route.ts");
    expect(source).toContain("const failedHeld = entries");
    expect(source).toContain("held symbol(s) will be retried by the next holding research pass");
  });
});
