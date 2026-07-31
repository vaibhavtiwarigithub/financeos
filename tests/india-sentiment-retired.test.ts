import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyIntent, contractsFor } from "@/lib/evidence/intent-classification";

describe("retired India GDELT scoring path", () => {
  it("marks canonical sentiment scoring unsupported for India", () => {
    expect(classifyIntent("sentiment.news", "india")).toBe("unsupported");
    expect(contractsFor("india", "equity").some((contract) => contract.dimension === "sentiment")).toBe(false);
  });

  it("does not call the legacy India sentiment fetcher from ResearchAgent", () => {
    const source = readFileSync("lib/research-agent.ts", "utf8");
    expect(source).not.toContain("fetchIndiaNewsSentiment");
    const indiaBranch = source.slice(source.indexOf("if (india) {"), source.indexOf("return dims;", source.indexOf("if (india) {")));
    expect(indiaBranch).not.toContain('dims.add("sentiment")');
  });
});
