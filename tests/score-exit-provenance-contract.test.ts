import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const paper = readFileSync("app/api/agents/position-monitor/route.ts", "utf8");
const live = readFileSync("lib/trading/live-exit-monitor.ts", "utf8");

describe("score-exit provenance contract", () => {
  it("requires a holding signal and rejects prior position episodes in paper", () => {
    expect(paper).toContain('.eq("is_holding", true)');
    expect(paper).toContain('q.gte("created_at", openedAt)');
    expect(paper).toContain("isHoldingExitSignal({");
  });

  it("requires a holding signal and rejects prior position episodes in live", () => {
    expect(live).toContain('.eq("is_holding", true).gte("created_at", position.firstBuyAt)');
    expect(live).toContain("isHoldingExitSignal({");
  });

  it("has no candidate-accessible immediate score exit", () => {
    expect(paper).not.toContain("scoreBelowExit && !directionFlipped");
    expect(live).not.toContain("scoreBelowExit && !directionFlipped");
    expect(paper).toContain("score_below_exit_threshold_confirmed");
    expect(live).toContain("score_below_exit_threshold_confirmed");
  });

  it("does not let score-exit state suppress a protective stop", () => {
    expect(paper).toContain("scoreExitConfirmed");
    expect(paper).toContain("if (!exitReason && scoreExitConfirmed)");
    expect(live).toContain('decision.action === "stop_full"');
  });
});
