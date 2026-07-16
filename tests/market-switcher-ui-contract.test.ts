import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("market-switcher UI contracts", () => {
  it("uses the per-market paper seed on the Agents page", () => {
    const agents = source("components/dashboard/AgentsPage.tsx");
    expect(agents).toContain("paperStartNav(market)");
    expect(agents).not.toContain("const startingNAV = 10000");
    expect(agents).toContain("paperPortfolio?.cash_balance ?? startingNAV");
  });

  it("cannot invoke the US Trader flow from the India view", () => {
    const agents = source("components/dashboard/AgentsPage.tsx");
    expect(agents).toContain('market === "india" && a.id === "trader"');
    expect(agents).toContain('market === "india" ? (');
    expect(agents).toContain("Live proposals are US-only");
  });

  it("passes the selected market explicitly to the embedded backtest", () => {
    const agents = source("components/dashboard/AgentsPage.tsx");
    expect(agents).toMatch(/body:\s*JSON\.stringify\(\{\s*market,/);
    expect(agents).toContain("backtestResult.benchmark_symbol");
  });

  it("owner-gates service-role market-history reads", () => {
    for (const path of [
      "app/api/agents/performance/route.ts",
      "app/api/strategies/versions/route.ts",
      "app/api/charts/score-history/route.ts",
    ]) {
      const route = source(path);
      expect(route).toContain("await requireOwner()");
      expect(route).toContain("if (gate) return gate");
    }
  });
});
