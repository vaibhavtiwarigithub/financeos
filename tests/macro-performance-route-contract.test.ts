import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("macro performance route maturity contract", () => {
  const route = readFileSync("app/api/learning/macro-performance/route.ts", "utf8");

  it("loads only matured forward-return labels before calculating evidence", () => {
    expect(route).toContain('.not("fwd_return", "is", null)');
    expect(route).toContain('.lte("matured_at", new Date().toISOString())');
    expect(route).toContain("buildMacroForwardEvidence(market, labels as any[], factorRows)");
  });
});
