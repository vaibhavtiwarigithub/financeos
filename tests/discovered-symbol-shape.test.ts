import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPlausibleDiscoveredUsSymbol } from "@/lib/research/symbol-shape";

describe("isPlausibleDiscoveredUsSymbol", () => {
  it("accepts ordinary tickers, ETFs and class shares", () => {
    for (const s of ["AAPL", "MSFT", "F", "GOOGL", "SPY", "REMX", "BRK.B", "BF-B", "brk.b"]) expect(isPlausibleDiscoveredUsSymbol(s)).toBe(true);
  });
  it("rejects the futures-style code that failed every prewarm (IXAZ6) and other non-equity shapes", () => {
    for (const s of ["IXAZ6", "ESZ6", "AAPL240119C00150000", "TOOLONGNAME", "", "A B", "BTC-USD", "123", "UNIVAFOODS.NS"]) expect(isPlausibleDiscoveredUsSymbol(s)).toBe(false);
  });
  it("is applied to screener-discovered sources only, never holdings or the owner watchlist", () => {
    const src = readFileSync("lib/research-agent.ts", "utf8");
    expect(src).toContain('const SHAPE_CHECKED_SOURCES = new Set<string>(["screener_momentum", "screener_value", "edge_relative_strength"])');
    expect(src).toContain("SHAPE_CHECKED_SOURCES.has(source) && !isPlausibleDiscoveredUsSymbol(sym)");
    expect(src).not.toContain('SHAPE_CHECKED_SOURCES = new Set<string>(["watchlist"');
  });
});
