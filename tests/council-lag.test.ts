import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { findStalledWorkers, findUnscoredResearch } from "@/lib/monitoring/council-lag";

const now = new Date("2026-10-13T12:00:00Z");
const obs = (id: number, symbol: string, ts: string, market: "us" | "india" = "us") => ({ id, symbol, ts, market });

describe("council silence detection", () => {
  it("flags a symbol whose newest observation is past grace and has no council run", () => {
    const found = findUnscoredResearch({ now, observations: [obs(1, "AAA", "2026-10-13T09:00:00Z"), obs(2, "BBB", "2026-10-13T09:00:00Z")], scoredObservationIds: new Set([2]) });
    expect(found.get("us")).toMatchObject({ count: 1, example: "AAA" });
  });
  it("ignores observations still inside the grace period and superseded older observations of a scored symbol", () => {
    const found = findUnscoredResearch({
      now,
      observations: [obs(1, "AAA", "2026-10-13T04:00:00Z"), obs(2, "AAA", "2026-10-13T07:00:00Z"), obs(3, "CCC", "2026-10-13T11:00:00Z")],
      scoredObservationIds: new Set([2]),
    });
    expect(found.size).toBe(0);
  });
  it("keeps markets apart", () => {
    const found = findUnscoredResearch({ now, observations: [obs(1, "RELIANCE.NS", "2026-10-13T05:00:00Z", "india")], scoredObservationIds: new Set() });
    expect([...found.keys()]).toEqual(["india"]);
  });
  it("reports worker families whose jobs have been queued past grace (PC off / CLI signed out)", () => {
    const stalled = findStalledWorkers({ now, jobs: [{ family: "claude", created_at: "2026-10-13T08:00:00Z" }, { family: "claude", created_at: "2026-10-13T09:00:00Z" }, { family: "codex", created_at: "2026-10-13T11:30:00Z" }] });
    expect(stalled.get("claude")).toMatchObject({ count: 2, oldest: "2026-10-13T08:00:00Z" });
    expect(stalled.has("codex")).toBe(false);
  });
  it("the Learning IC route orders by the table's real timestamp column (production 500 on 2026-10-13: created_at does not exist)", () => {
    const route = readFileSync("app/api/learning/council-ic/route.ts", "utf8");
    expect(route).toContain('.order("evaluated_at"');
    expect(route).not.toMatch(/llm_council_ic_runs"\)\.select\("[^"]*created_at/);
    const migrations = readFileSync("supabase/migrations/20260930144755_llm_council_shadow.sql", "utf8");
    expect(migrations).toMatch(/llm_council_ic_runs[\s\S]*evaluated_at/);
  });
});
