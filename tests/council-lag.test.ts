import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { findStalledWorkers, findTerminalCouncilGaps, findUnscoredResearch } from "@/lib/monitoring/council-lag";

const now = new Date("2026-10-13T12:00:00Z");
const obs = (id: number, symbol: string, ts: string, market: "us" | "india" = "us") => ({ id, symbol, ts, market });

describe("council silence detection", () => {
  it("flags only terminal local-member jobs and retains symbol/status context", () => {
    const gaps = findTerminalCouncilGaps({ jobs: [
      { family: "claude", model: "claude-sonnet-5-5", market: "india", symbol: "RELIANCE.NS", runId: "1", status: "expired", failure_code: "deadline_expired", created_at: "2026-10-13T08:00:00Z" },
      { family: "codex", model: "gpt-5.6-luna", market: "us", symbol: "SOXS", runId: "2", status: "failed", failure_code: "model_unavailable", created_at: "2026-10-13T09:00:00Z" },
      { family: "deepseek", model: "deepseek-flash", market: "us", symbol: "SOXL", runId: "3", status: "failed", created_at: "2026-10-13T09:00:00Z" },
      { family: "codex", model: "gpt-5.6-luna", market: "us", symbol: "SOXS", runId: "4", status: "failed", created_at: "2026-10-13T09:00:00Z", hasCompletedForecast: true },
    ] });
    expect(gaps.get("india:claude")).toMatchObject({ count: 1, symbols: ["RELIANCE.NS"], statuses: ["expired"] });
    expect(gaps.get("us:codex")).toMatchObject({ count: 1, symbols: ["SOXS"], statuses: ["failed"], failureCodes: { model_unavailable: 1 } });
    expect(gaps.has("us:deepseek")).toBe(false);
  });

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
  it("distinguishes an active worker draining an old backlog from a stopped worker", () => {
    const workers = findStalledWorkers({
      now,
      jobs: [
        { family: "claude", created_at: "2026-10-13T08:00:00Z", last_seen_at: "2026-10-13T11:45:00Z" },
        { family: "codex", created_at: "2026-10-13T08:00:00Z", last_seen_at: "2026-10-13T10:00:00Z" },
      ],
    });
    expect(workers.get("claude")).toMatchObject({ active: true, lastSeenAt: "2026-10-13T11:45:00Z" });
    expect(workers.get("codex")).toMatchObject({ active: false });
  });
  it("the Learning IC route orders by the table's real timestamp column (production 500 on 2026-10-13: created_at does not exist)", () => {
    const route = readFileSync("app/api/learning/council-ic/route.ts", "utf8");
    expect(route).toContain('.order("evaluated_at"');
    expect(route).not.toMatch(/llm_council_ic_runs"\)\.select\("[^"]*created_at/);
    const migrations = readFileSync("supabase/migrations/20260930144755_llm_council_shadow.sql", "utf8");
    expect(migrations).toMatch(/llm_council_ic_runs[\s\S]*evaluated_at/);
  });
});
