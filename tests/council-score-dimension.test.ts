import { describe, expect, it } from "vitest";
import { councilMemberOf, mergeCouncilPoints, toCouncilPoints, toScorePoints } from "@/lib/research/score-history";

const run = (id: string, decision_ts: string, status = "completed", consensus_score: number | string | null = null) => ({ id, decision_ts, status, consensus_score });
const fc = (run_id: string, model_requested: string, final_score: number) => ({ run_id, model_requested, final_score });

describe("LLM council as a score dimension", () => {
  it("maps requested models to the three members and refuses to guess others", () => {
    expect(councilMemberOf("deepseek-flash")).toBe("deepseek");
    expect(councilMemberOf("claude-sonnet-4-6")).toBe("claude");
    expect(councilMemberOf("gpt-5.6-sol")).toBe("codex");
    expect(councilMemberOf("gemini-2.5-pro")).toBeNull();
  });
  it("uses the stored consensus, and one point per day (last run of the day wins)", () => {
    const pts = toCouncilPoints(
      [run("a", "2026-10-12T04:05:00Z", "completed", "50.00"), run("b", "2026-10-12T07:05:00Z", "completed", "61.00"), run("c", "2026-10-13T04:05:00Z", "completed", "40")],
      [fc("b", "deepseek-flash", 60), fc("b", "claude-sonnet-4-6", 61), fc("b", "gpt-5.6-sol", 62)],
    );
    expect(pts.map((p) => [p.date, p.council, p.council_runs])).toEqual([["2026-10-12", 61, 2], ["2026-10-13", 40, 1]]);
    expect(pts[0]).toMatchObject({ council_deepseek: 60, council_claude: 61, council_codex: 62 });
  });
  it("backfilled runs (null consensus) get the median of ALL THREE members, never a median of two", () => {
    const three = toCouncilPoints([run("x", "2026-10-12T07:05:00Z", "partial", null)], [fc("x", "deepseek-flash", 30), fc("x", "claude-sonnet-4-6", 50), fc("x", "gpt-5.6-sol", 40)]);
    expect(three[0].council).toBe(40);
    const two = toCouncilPoints([run("y", "2026-10-12T07:05:00Z", "partial", null)], [fc("y", "deepseek-flash", 30), fc("y", "gpt-5.6-sol", 40)]);
    expect(two[0].council).toBeNull();
    expect(two[0]).toMatchObject({ council_deepseek: 30, council_codex: 40, council_claude: null });
  });
  it("merges onto research points and keeps council-only days as null-score points", () => {
    const research = toScorePoints([{ created_at: "2026-10-12T07:00:00Z", analyst_score: 65, fundamental_score: 70, technical_score: 50, sentiment_score: 50, macro_score: 50, insider_score: 50, direction: "long", conviction: 65, score_source: "deterministic_v1", scoring_version: "v1" }]);
    const merged = mergeCouncilPoints(research, toCouncilPoints([run("a", "2026-10-12T07:05:00Z", "completed", 58), run("b", "2026-10-14T07:05:00Z", "completed", 44)], []));
    expect(merged.map((p) => [p.date, p.analyst, p.council])).toEqual([["2026-10-12", 65, 58], ["2026-10-14", null, 44]]);
  });
});
