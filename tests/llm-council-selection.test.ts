import { describe, expect, it } from "vitest";
import { selectCouncilCandidates } from "@/lib/llm-council/selection";
import { COUNCIL_ALL_RESEARCH_COHORT_KEY } from "@/lib/llm-council/cohort";

const sessionOf = (iso: string) => iso.slice(0, 10);
const obs = (id: number, symbol: string, ts: string, analyst: number, direction = "long", threshold = 60) => ({
  id, symbol, ts, analyst_score: analyst, score_threshold: threshold, direction, decision_context: "entry_candidate",
});

describe("council candidate selection (every new observation, i.e. every research slot)", () => {
  it("returns every symbol, not only near-threshold ones, newest observation each", () => {
    const rows = [
      obs(1, "AAA", "2026-10-12T10:00:00Z", 90), obs(2, "AAA", "2026-10-12T15:00:00Z", 91),
      obs(3, "BBB", "2026-10-12T15:00:00Z", 30, "short"), obs(4, "CCC", "2026-10-12T15:00:00Z", 61),
    ];
    const picked = selectCouncilCandidates({ observations: rows, priorRuns: [] });
    expect(picked.map((r) => r.symbol).sort()).toEqual(["AAA", "BBB", "CCC"]);
    expect(picked.find((r) => r.symbol === "AAA")?.id).toBe(2);
  });
  it("orders near-threshold entry longs first, then the rest by distance", () => {
    const rows = [obs(1, "FAR", "2026-10-12T15:00:00Z", 95), obs(2, "NEAR", "2026-10-12T15:00:00Z", 62), obs(3, "SHORT", "2026-10-12T15:00:00Z", 61, "short")];
    expect(selectCouncilCandidates({ observations: rows, priorRuns: [] }).map((r) => r.symbol)).toEqual(["NEAR", "SHORT", "FAR"]);
  });
  it("scores each research slot: a newer observation of an already-scored symbol is scored again", () => {
    const priorRuns = [{ observation_id: 5, symbol: "AAA", decision_ts: "2026-10-12T04:00:00Z" }];
    const slotB = [obs(10, "AAA", "2026-10-12T07:00:00Z", 70), obs(11, "BBB", "2026-10-12T07:00:00Z", 70)];
    expect(selectCouncilCandidates({ observations: slotB, priorRuns }).map((r) => r.symbol).sort()).toEqual(["AAA", "BBB"]);
  });
  it("never re-runs an observation that already has a run", () => {
    const rows = [obs(7, "ZZZ", "2026-10-12T18:00:00Z", 70)];
    expect(selectCouncilCandidates({ observations: rows, priorRuns: [{ observation_id: 7, symbol: "ZZZ", decision_ts: "2026-10-01T00:00:00Z" }] })).toEqual([]);
  });
  it("names the cohort", () => { expect(COUNCIL_ALL_RESEARCH_COHORT_KEY).toBe("all_research_v1"); });
});
