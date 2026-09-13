import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("live-exit shadow action contract", () => {
  const migration = readFileSync("supabase/migrations/20260913103000_live_exit_ladder_shadow_action_contract.sql", "utf8");
  const monitor = readFileSync("lib/trading/live-exit-monitor.ts", "utf8");

  it("preserves legacy observations while admitting every action the monitor can write", () => {
    for (const action of ["none", "stop_full", "partial_target", "target_full", "time_stop", "runner_hold", "score_exit"]) {
      expect(migration).toContain(`'${action}'`);
    }
  });

  it("never silently discards a rejected shadow observation", () => {
    expect(monitor).toContain("const { error: shadowWriteError }");
    expect(monitor).toContain("live-exit-shadow-write:");
    expect(monitor).toContain('reason: "shadow_write_failed"');
  });
});
