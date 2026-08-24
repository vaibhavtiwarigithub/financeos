import { describe, expect, it } from "vitest";
import { classifyInstrumentPolicy } from "@/lib/scoring/instrument-taxonomy";

describe("instrument-aware taxonomy", () => {
  it.each([
    ["GLD", "gold_bullion_fund", "gold_spot"],
    ["IAU", "gold_bullion_fund", "gold_spot"],
    ["SLV", "silver_bullion_fund", "silver_spot"],
    ["GDX", "gold_miners_fund", "gold_miners"],
    ["KGC", "metal_producer_equity", "gold_miners"],
    ["FNV", "royalty_streaming_equity", "gold_royalty_streaming"],
  ])("classifies %s without conflating its exposure", (symbol, family, exposureId) => {
    const result = classifyInstrumentPolicy({ symbol, market: "us" });
    expect(result.family).toBe(family);
    expect(result.exposureId).toBe(exposureId);
  });

  it("classifies known India ETFs as funds, not operating companies", () => {
    expect(classifyInstrumentPolicy({ symbol: "GOLDBEES.NS", market: "india" }).family).toBe("india_etf");
    expect(classifyInstrumentPolicy({ symbol: "BANKBEES.NS", market: "india" }).exposureId).toBe("india_sector:banks");
  });

  it("blocks leveraged/inverse funds from the generic lane", () => {
    const result = classifyInstrumentPolicy({ symbol: "UGL", market: "us" });
    expect(result.family).toBe("leveraged_or_inverse_etf");
    expect(result.scoreMode).toBe("blocked");
  });

  it("uses sector context for banks and REITs", () => {
    expect(classifyInstrumentPolicy({ symbol: "JPM", market: "us", industry: "Banks—Diversified" }).family).toBe("bank");
    expect(classifyInstrumentPolicy({ symbol: "O", market: "us", industry: "REIT—Retail" }).family).toBe("reit");
  });
});
