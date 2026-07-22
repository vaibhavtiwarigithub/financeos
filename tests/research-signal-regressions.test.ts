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

  it("fails before inserting when stale-signal supersession fails", () => {
    const source = read("lib/research-agent.ts");
    const pendingUpdate = source.indexOf("pendingSupersessionError");
    const pendingThrow = source.indexOf("agent_signals pending supersession failed");
    const signalInsert = source.indexOf('from("agent_signals").insert(signalRow)');
    expect(pendingUpdate).toBeGreaterThan(0);
    expect(pendingThrow).toBeGreaterThan(pendingUpdate);
    expect(signalInsert).toBeGreaterThan(pendingThrow);
  });
});
