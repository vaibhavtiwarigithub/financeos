import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The liquidity floor protects the paper book from modeled fills in untradeable India names. These checks pin its wiring so a
// refactor cannot silently drop the gate or move it behind pricing (where thin names would hit the stale-quote gate first).
const src = readFileSync("app/api/agents/paper-trade/route.ts", "utf8");

describe("paper-trade India liquidity wiring", () => {
  it("checks the liquidity floor for India before the price lookup, after the claim", () => {
    const claim = src.indexOf('status: "claiming"');
    const floor = src.indexOf("assessLiquidityFloor(advByIndiaSymbol");
    const price = src.indexOf("const pf = await priceFor(signal, market);");
    expect(claim).toBeGreaterThan(-1);
    expect(floor).toBeGreaterThan(claim);
    expect(price).toBeGreaterThan(floor);
  });
  it("applies the participation cap after sizing and only to India", () => {
    const sized = src.indexOf("let totalCost = qty * fillPrice;");
    const cap = src.indexOf("assessParticipation(advByIndiaSymbol");
    expect(cap).toBeGreaterThan(sized);
    expect(src.slice(sized, cap)).toContain('market === "india"');
  });
  it("reverts the signal claim whenever a liquidity gate rejects", () => {
    const gate = [...src.matchAll(/stage: "liquidity_gate"/g)];
    expect(gate.length).toBe(2);
    for (const m of gate) expect(src.slice(Math.max(0, m.index! - 400), m.index!)).toContain("await revertClaim(signal.id)");
  });
  it("never blocks exits: the gate lives in the entry loop, not in position-monitor", () => {
    expect(readFileSync("app/api/agents/position-monitor/route.ts", "utf8")).not.toContain("liquidity-floor");
  });
});
