import { describe, expect, it } from "vitest";
import { fingerprintRobinhoodMcpTools, ROBINHOOD_RESEARCH_READ_TOOLS } from "@/lib/robinhood-mcp";

describe("Robinhood MCP capability fingerprint", () => {
  it("is stable across server tool ordering and ignores untrusted descriptions", () => {
    const first = fingerprintRobinhoodMcpTools([
      { name: "get_financials", description: "remote text", inputSchema: { type: "object", properties: { symbols: { type: "array" } } } },
      { name: "review_equity_order", description: "other remote text", inputSchema: { type: "object", properties: { symbol: { type: "string" } } } },
    ]);
    const second = fingerprintRobinhoodMcpTools([
      { name: "review_equity_order", description: "changed description", inputSchema: { type: "object", properties: { symbol: { type: "string" } } } },
      { name: "get_financials", description: "changed description", inputSchema: { type: "object", properties: { symbols: { type: "array" } } } },
    ]);
    expect(first.toolNames).toEqual(["get_financials", "review_equity_order"]);
    expect(first.schemaFingerprint).toBe(second.schemaFingerprint);
  });

  it("changes when the input contract changes", () => {
    const original = fingerprintRobinhoodMcpTools([{ name: "get_financials", inputSchema: { type: "object", properties: { symbols: { type: "array" } } } }]);
    const changed = fingerprintRobinhoodMcpTools([{ name: "get_financials", inputSchema: { type: "object", properties: { ticker: { type: "string" } } } }]);
    expect(changed.schemaFingerprint).not.toBe(original.schemaFingerprint);
  });

  it("keeps research reads structurally separated from execution tools", () => {
    expect(ROBINHOOD_RESEARCH_READ_TOOLS).toContain("get_option_quotes");
    expect(ROBINHOOD_RESEARCH_READ_TOOLS).toContain("get_earnings_calendar");
    expect(ROBINHOOD_RESEARCH_READ_TOOLS.some((name) => /order|cancel|review/i.test(name))).toBe(false);
  });
});
