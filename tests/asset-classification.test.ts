import { describe, expect, it } from "vitest";
import { classifyJournalAsset, isEtfSymbol } from "@/lib/asset-classification";

describe("asset classification", () => {
  it("recognizes researched funds that were previously misclassified", () => {
    for (const symbol of ["EUAD", "DXJ", "TEM", "DBA", "SCHD", "VTV", "SPHQ", "ASHR", "EMXC"]) {
      expect(isEtfSymbol(symbol), symbol).toBe(true);
      expect(classifyJournalAsset(symbol, "us_equity"), symbol).toBe("etf");
    }
  });

  it("keeps operating companies and India listings distinct", () => {
    expect(classifyJournalAsset("MU", "us_equity")).toBe("company");
    expect(classifyJournalAsset("SKHY", "adr")).toBe("adr");
    expect(classifyJournalAsset("HDFCBANK.NS", "india")).toBe("india_company");
  });

  it("respects the recorded metal-fund class", () => {
    expect(classifyJournalAsset("GLD", "metal")).toBe("metal_fund");
  });
});
