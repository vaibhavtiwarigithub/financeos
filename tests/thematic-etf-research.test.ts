import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isEtfSymbol, isEquityFundamentalsApplicable } from "@/lib/asset-classification";
import { dimensionApplicability } from "@/lib/scoring/dimension-applicability";
import { classifyInstrumentPolicy } from "@/lib/scoring/instrument-taxonomy";
import { orderHoldingsByStaleness } from "@/lib/research/holding-symbols";

const funds = ["QTUM", "BOTZ", "ARKQ", "ROBO", "ROBT"];
describe("quantum/robotics fund research correction", () => {
  it.each(funds)("routes %s to existing ETF applicability, not issuer ratios", (symbol) => {
    expect(isEtfSymbol(symbol.toLowerCase())).toBe(true);
    expect(isEquityFundamentalsApplicable(symbol)).toBe(false);
    expect(classifyInstrumentPolicy({ symbol, market: "us" }).family).toBe("thematic_etf");
    const dimensions = dimensionApplicability({ symbol, market: "us" });
    expect(dimensions.fundamental.state).toBe("not_applicable");
    expect(dimensions.insider.state).toBe("not_applicable");
    expect(dimensions.technical.state).toBe("applicable");
    expect(dimensions.sentiment.state).toBe("applicable");
  });
  it("rotates a larger manual pool without increasing its slots", () => {
    const previous = Array.from({ length: 42 }, (_, i) => `S${String(i).padStart(2, "0")}`);
    const pool = [...previous, ...funds];
    const history = new Map(previous.map((s) => [s, "2026-10-20T13:00:00Z"]));
    const first = orderHoldingsByStaleness(pool, history).slice(0, 30);
    expect(funds.every((s) => first.includes(s))).toBe(true);
    for (const symbol of first) history.set(symbol, "2026-10-21T13:00:00Z");
    const second = orderHoldingsByStaleness(pool, history).slice(0, 30);
    expect(new Set([...first, ...second]).size).toBe(pool.length);
    expect(first.length).toBe(30); expect(second.length).toBe(30);
  });
  it("wires the existing ordering after the leveraged priority and before carry-forward", () => {
    const source = readFileSync("lib/research-agent.ts", "utf8");
    const manual = source.indexOf('orderHoldingsByLastScored(supabase, watchlist.usManual, "us")');
    expect(manual).toBeGreaterThan(source.indexOf('for (const sym of LEVERAGED_SLEEVE_SYMBOLS)'));
    expect(manual).toBeLessThan(source.indexOf('const deferredUs ='));
    expect(source).toContain('const candidateCap = researchCandidateCap("us")');
    expect(source).toContain('const discoveryReserve =');
  });
});
