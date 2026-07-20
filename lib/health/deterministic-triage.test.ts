import { describe, expect, it } from "vitest";
import { buildDeterministicTriage } from "./deterministic-triage";

describe("deterministic health triage", () => {
  it("does not report an older error after a newer successful run", () => {
    const result = buildDeterministicTriage([], [
      { agent_type: "research", market: "us", status: "error", started_at: "2026-07-15T13:00:00Z", result_summary: "timeout" },
      { agent_type: "research", market: "us", status: "done", started_at: "2026-07-16T13:00:00Z" },
    ]);
    expect(result.issues).toEqual([]);
    expect(result.summary).toBe("All monitored systems are normal.");
  });

  it("preserves current alert severity and action detail", () => {
    const result = buildDeterministicTriage([
      { issue_key: "broker-token:kite", severity: "warn", category: "broker", title: "Kite expired", detail: "Reconnect Kite." },
    ], []);
    expect(result.issues[0]).toMatchObject({ issue_key: "broker-token:kite", severity: "warn", suggested_fix: "Reconnect Kite." });
    expect(result.summary).toContain("1 action required");
  });

  it("reports only a latest unresolved run error", () => {
    const result = buildDeterministicTriage([], [
      { agent_type: "position_monitor", market: "india", status: "done", started_at: "2026-07-16T10:00:00Z" },
      { agent_type: "position_monitor", market: "india", status: "error", started_at: "2026-07-16T11:00:00Z", error: "price read failed" },
    ]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].root_cause).toBe("price read failed");
  });
});
