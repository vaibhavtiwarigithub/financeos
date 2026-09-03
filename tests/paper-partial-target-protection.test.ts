import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Paper partial-target runner protection", () => {
  it("routes the runner stop through the non-loosening helper", () => {
    const monitor = readFileSync("app/api/agents/position-monitor/route.ts", "utf8");
    expect(monitor).toContain("paperRunnerStopPrice(pos.avg_cost, trailingStop)");
    expect(monitor).not.toContain("partialStopOverride = Number(pos.avg_cost)");
  });
});
