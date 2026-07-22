import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("PositionMonitor run timing", () => {
  it("persists the request start on success, empty-book, and error bookkeeping", () => {
    const source = readFileSync(join(process.cwd(), "app/api/agents/position-monitor/route.ts"), "utf8");
    expect(source.match(/started_at: startedAt/g)).toHaveLength(3);
    expect(source).toContain("runMonitor(scope, startedAt)");
    expect(source).toContain("logMonitorError(scope, msg, startedAt)");
  });
});
