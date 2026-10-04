import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requiredPriceScope } from "@/lib/monitoring/freshness-contracts";

describe("prewarm scope drops research-disabled, unheld names (ABB/IRBT/TMHC kept an alert open for 3 weeks)", () => {
  it("rule: disabled names leave the scope unless held", () => {
    const scope = requiredPriceScope(["AAPL", "ABB", "IRBT"], ["IRBT"], ["ABB", "IRBT", "TMHC"]);
    expect([...scope].sort()).toEqual(["AAPL", "IRBT"]);
  });
  it("the route applies it before resolving the scope", () => {
    const src = readFileSync("app/api/agents/price-prewarm/route.ts", "utf8");
    expect(src).toContain("requiredPriceScope(");
    expect(src).toContain('.eq("research_enabled", false)');
    expect(src.indexOf("requiredPriceScope(")).toBeLessThan(src.indexOf("resolvePrewarmScope({"));
  });
});
