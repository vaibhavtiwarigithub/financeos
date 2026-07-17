import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildKiteGttBody } from "@/lib/kite";
import { getMcpBroker } from "@/lib/brokers/mcp-registry";

describe("Kite protective-order safety", () => {
  it("builds GTT with LIMIT children only", () => {
    const body = buildKiteGttBody({
      tradingsymbol: "RELIANCE.NS",
      qty: 2,
      lastPrice: 3000,
      stopPrice: 2850,
      targetPrice: 3300,
    });
    const orders = JSON.parse(body.orders);
    expect(orders).toEqual([
      { transaction_type: "SELL", quantity: 2, order_type: "LIMIT", product: "CNC", price: 2850 },
      { transaction_type: "SELL", quantity: 2, order_type: "LIMIT", product: "CNC", price: 3300 },
    ]);
  });

  it("confirms GTT cancellation before submitting an explicit SELL", () => {
    const source = readFileSync("app/api/kite/order/route.ts", "utf8");
    const cancel = source.indexOf("const cancel = await cancelKiteGtt");
    const submit = source.indexOf("const res = await placeEquityOrder");
    expect(cancel).toBeGreaterThan(0);
    expect(submit).toBeGreaterThan(cancel);
    expect(source).toContain("SELL not submitted");
    expect(source).toContain("Partial SELL blocked");
  });
});

describe("research holding and market contracts", () => {
  it("persists holding provenance and never treats candidate neutral as an exit flip", () => {
    const research = readFileSync("lib/research-agent.ts", "utf8");
    const monitor = readFileSync("app/api/agents/position-monitor/route.ts", "utf8");
    expect(research).toContain("is_holding: isHeld");
    expect(research).toContain('.eq("research_enabled", true)');
    expect(monitor).toContain('sc?.isHolding === true');
    expect(monitor).toContain('sc.score < exitThreshold');
    expect(monitor).not.toContain('sc.direction !== "long"');
  });
});

describe("Webull MCP remains read-only", () => {
  it("does not advertise invented MCP order tools or scopes", () => {
    const cfg = getMcpBroker("webull");
    expect(cfg?.orderCapable).toBe(false);
    expect(cfg?.orderTools).toBeUndefined();
    expect(cfg?.orderScopes).toBeUndefined();
  });
});
