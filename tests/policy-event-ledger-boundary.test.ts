import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("policy-event ledger boundary", () => {
  it("keeps policy-event data out of scoring and execution paths", () => {
    for (const file of [
      "lib/data/scores.ts",
      "lib/research-agent.ts",
      "app/api/agents/paper-trade/route.ts",
      "app/api/agents/position-monitor/route.ts",
      "lib/trading/execute-order.ts",
    ]) {
      expect(read(file)).not.toContain("policy_rate_events");
      expect(read(file)).not.toContain("policy_event_impacts");
    }
  });

  it("requires frozen return evidence rather than a quote-provider call", () => {
    const route = read("app/api/agents/policy-events/route.ts");
    expect(route).toContain('from("symbol_daily_returns")');
    expect(route).not.toContain("fetchUsCandles");
    expect(route).not.toContain("fetchYahooCandles");
    expect(route).not.toContain("MASSIVE_API_KEY");
  });
});
