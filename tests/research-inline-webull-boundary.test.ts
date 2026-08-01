import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("ResearchAgent Webull shadow boundary", () => {
  const source = readFileSync(join(process.cwd(), "lib/research-agent.ts"), "utf8");

  it("keeps direct per-symbol Webull MCP research source-disabled", () => {
    expect(source).toContain("const INLINE_WEBULL_RESEARCH_AVAILABLE = false;");
    expect(source).toContain("!india && !isHeld && INLINE_WEBULL_RESEARCH_AVAILABLE");
  });
});
