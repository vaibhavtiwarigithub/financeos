import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Paper partial-target runner protection", () => {
  it("routes paper through the shared ladder's non-loosening runner stop", () => {
    const monitor = readFileSync("app/api/agents/position-monitor/route.ts", "utf8");
    const ladder = readFileSync("lib/trading/exit-ladder.ts", "utf8");
    expect(monitor).toContain('import { decideExitLadder } from "@/lib/trading/exit-ladder"');
    expect(monitor).toContain("partialStopOverride = ladderDecision.runnerStop");
    expect(ladder).toContain("paperRunnerStopPrice(input.avgEntry, trailingStop)");
    expect(monitor).not.toContain("partialStopOverride = Number(pos.avg_cost)");
  });
});
