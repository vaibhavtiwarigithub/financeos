import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildCouncilLatest } from "@/lib/research/council-latest";

const run = (id: string, symbol: string, market: string, decision_ts: string, status = "completed", consensus_score: number | string | null = null) => ({ id, symbol, market, decision_ts, status, consensus_score });
const fc = (run_id: string, model_requested: string, final_score: number) => ({ run_id, model_requested, final_score });

describe("Fundamentals page: LLM council columns (3 members + composite)", () => {
  it("takes the newest run per symbol AND market, never crossing markets", () => {
    const m = buildCouncilLatest(
      [run("a", "AAA", "us", "2026-10-12T14:00:00Z", "completed", 50), run("b", "AAA", "us", "2026-10-13T14:00:00Z", "completed", 60), run("c", "AAA", "india", "2026-10-13T05:00:00Z", "completed", 70)],
      [fc("b", "deepseek-flash", 58), fc("b", "claude-sonnet-5-5", 60), fc("b", "gpt-5.6-luna", 62)],
    );
    expect(m.get("AAA:us")).toMatchObject({ council_score: 60, council_deepseek: 58, council_claude: 60, council_codex: 62, council_as_of: "2026-10-13T14:00:00Z" });
    expect(m.get("AAA:india")?.council_score).toBe(70);
  });
  it("maps members by model family so a model upgrade keeps its column (Sonnet 4.6 -> 5.5, sol -> luna)", () => {
    const m = buildCouncilLatest([run("a", "ZZZ", "us", "2026-10-13T14:00:00Z", "completed", 55)], [fc("a", "claude-sonnet-4-6", 1), fc("a", "claude-sonnet-5-5", 52), fc("a", "gpt-5.6-sol", 3), fc("a", "gpt-5.6-luna", 54)]);
    // Both generations map to the same member column; the later row for a member wins (rows arrive in write order).
    expect(m.get("ZZZ:us")).toMatchObject({ council_claude: 52, council_codex: 54 });
  });
  it("shows a composite for a backfilled run only when all three members exist, never a median of two", () => {
    const three = buildCouncilLatest([run("x", "AAA", "us", "2026-10-13T14:00:00Z", "partial", null)], [fc("x", "deepseek-flash", 30), fc("x", "claude-sonnet-5-5", 50), fc("x", "gpt-5.6-luna", 40)]);
    expect(three.get("AAA:us")?.council_score).toBe(40);
    const two = buildCouncilLatest([run("y", "BBB", "us", "2026-10-13T14:00:00Z", "partial", null)], [fc("y", "deepseek-flash", 30), fc("y", "gpt-5.6-luna", 40)]);
    expect(two.get("BBB:us")).toMatchObject({ council_score: null, council_deepseek: 30, council_codex: 40, council_claude: null });
  });
  it("the table has exactly the four requested columns, in the Scores view, sortable, exported, with a formula panel", () => {
    const page = readFileSync("app/dashboard/research/page.tsx", "utf8");
    for (const key of ["council_score", "council_deepseek", "council_claude", "council_codex"]) {
      expect(page).toMatch(new RegExp(`key: "${key}",[^\\n]*score: true`));
    }
    expect(page).toContain('"council_score","council_deepseek","council_claude","council_codex"]'); // Scores preset
    expect(page).toContain('csvLabel: "LLM Council Median (0-100)"');
    expect(page).toContain("council_score: {"); // formula panel entry
    const route = readFileSync("app/api/research/universe/route.ts", "utf8");
    expect(route).toContain("loadCouncilLatest");
    expect(route).toContain("council_codex");
    // Fail-soft: a council read error must not 500 the table.
    expect(route).toMatch(/try \{ council = await loadCouncilLatest\(sb\); \}\s*catch/);
  });
});
