import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("score-exit shadow isolation", () => {
  const route = readFileSync("app/api/agents/score-exit-shadow/route.ts", "utf8");
  const migration = readFileSync("supabase/migrations/20260911194147_score_exit_shadow_runs.sql", "utf8");

  it("requires verified holding provenance and paginates labels", () => {
    expect(route).toContain('.eq("session_validated", true).eq("is_holding", true)');
    expect(route).toContain("isHoldingReview");
    expect(route).toContain("fetchAllRows");
  });

  it("is append-only, owner-readable, daily, and explicitly measure-only", () => {
    expect(migration).toContain("score_exit_shadow_runs_no_mutate");
    expect(migration).toContain("score_exit_shadow_runs_owner_read");
    expect(migration).toContain("kairos-score-exit-shadow-us");
    expect(migration).toContain("kairos-score-exit-shadow-india");
    expect(migration).toContain("no score, position, exit, order or broker path may consume");
  });

  it("has no money-path consumer", () => {
    for (const file of [
      "app/api/agents/position-monitor/route.ts",
      "lib/trading/live-exit-monitor.ts",
      "lib/trading/autonomous-live.ts",
    ]) expect(readFileSync(file, "utf8")).not.toContain('from("score_exit_shadow_runs")');
  });
});
