import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const councilRef = /llm[_-]council|LLMCouncilPanel/i;
const MONEY_PATHS = [
  "lib/research-agent.ts",
  "lib/trading/capital-rotation.ts",
  "app/api/agents/paper-trade/route.ts",
  "app/api/agents/position-monitor/route.ts",
  "app/api/agents/autonomous-live/cron/route.ts",
  "app/api/broker/orders/sync/route.ts",
];

describe("LLM council safety boundary", () => {
  it("keeps council tables and scores out of all core scoring and execution paths", () => {
    for (const file of MONEY_PATHS) expect(readFileSync(file, "utf8"), file).not.toMatch(councilRef);
  });

  it("keeps owner control and scheduled collection behind separate auth gates", () => {
    const control = readFileSync("app/api/agents/llm-council/route.ts", "utf8");
    const collect = readFileSync("app/api/agents/llm-council/cron/route.ts", "utf8");
    const evaluate = readFileSync("app/api/agents/llm-council/evaluate/route.ts", "utf8");
    expect(control).toContain("requireOwner");
    expect(collect).toContain("verifyCronSecret");
    expect(evaluate).toContain("verifyCronSecret");
  });

  it("uses only prior-session peer bars and never substitutes raw returns for benchmark-neutral IC", () => {
    const collect = readFileSync("app/api/agents/llm-council/cron/route.ts", "utf8");
    const evaluate = readFileSync("app/api/agents/llm-council/evaluate/route.ts", "utf8");
    expect(collect).toContain('.lt("date", date)');
    expect(collect).not.toContain('.lte("date", date)');
    expect(evaluate).toContain("const outcome = row.benchmark_neutral_return;");
    expect(evaluate).not.toMatch(/benchmark_neutral_return\s*\?\?\s*fwd_return/);
  });

  it("instructs every council stage to emit strict ASCII JSON without prose", () => {
    const collect = readFileSync("app/api/agents/llm-council/cron/route.ts", "utf8");
    expect(collect).toContain("RFC 8259 JSON object using straight ASCII double quotes");
    expect(collect).toContain("No smart quotes, code fence, comments, trailing comma");
    expect(collect).toContain("no smart quotes, markdown fences, comments, trailing commas, or surrounding prose");
  });
});
