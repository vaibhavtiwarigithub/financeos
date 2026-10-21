import { describe, expect, it } from "vitest";
import { parseInvescoHoldings, parseSpdrHoldings, rankConstituentCoverage, fetchConstituentSnapshot, type ConstituentSnapshot } from "@/lib/research/etf-constituents";
import { parseNiftyConstituentsCsv } from "@/lib/nifty50-constituents";

const snapshot = (benchmark: string, symbols: string[]): ConstituentSnapshot => ({ benchmark, symbols,
  source: "https://issuer.example/holdings", asOf: "2026-10-20", observedAt: "2026-10-21T10:00:00Z", membership: "fund_holdings" });

describe("ETF constituent coverage", () => {
  it("validates small sector baskets without weakening the NIFTY-50 count contract", () => {
    const csv = ["Company Name,Industry,Symbol,Series,ISIN Code", ...Array.from({ length: 10 }, (_, i) => `Name,IT,STOCK${i},EQ,IN${i}`)].join("\n");
    expect(parseNiftyConstituentsCsv(csv, 10)).toHaveLength(10);
    expect(parseNiftyConstituentsCsv(csv, 50)).toBeNull();
    expect(parseNiftyConstituentsCsv(csv + "\nName,IT,STOCK0,EQ,IN0", 10, 20)).toBeNull();
  });

  it("rejects a partial issuer JSON response rather than quietly losing constituents", () => {
    const holdings = Array.from({ length: 100 }, (_, i) => ({ ticker: `STOCK${i}`, securityTypeCode: "COM" }));
    const full = { holdings, totalNumberOfHoldings: 100, effectiveDate: "2026-10-20" };
    expect(parseInvescoHoldings(full).symbols).toHaveLength(100);
    expect(() => parseInvescoHoldings({ ...full, holdings: holdings.slice(0, 99) })).toThrow("count_mismatch");
    expect(() => parseInvescoHoldings({ ...full, holdings: [...holdings.slice(0, 99), holdings[0]] })).toThrow("invalid_equity_list");
    expect(() => parseInvescoHoldings({ ...full, cusip: "WRONG" })).toThrow("fund_mismatch");
    expect(() => parseSpdrHoldings(Buffer.from("<html>temporarily unavailable</html>"))).toThrow("workbook_missing");
  });

  it("retains ADR equities and excludes futures/cash from constituent company research", () => {
    const holdings = [
      ...Array.from({ length: 98 }, (_, i) => ({ ticker: `STOCK${i}`, securityTypeCode: "COM" })),
      { ticker: "ARM", securityTypeCode: "ADR" }, { ticker: "ASML", securityTypeCode: "DRNY" },
      { ticker: "USD", securityTypeCode: "CURR" }, { ticker: "NQZ6", securityTypeCode: "IFUT" },
    ];
    const result = parseInvescoHoldings({ holdings, totalNumberOfHoldings: holdings.length, effectiveDate: "2026-10-20" });
    expect(result.symbols).toContain("ARM"); expect(result.symbols).toContain("ASML");
    expect(result.symbols).not.toContain("USD"); expect(result.symbols).not.toContain("NQZ6");
  });

  it("researches leaders first while circulating stale names and deduplicating overlapping ETFs", () => {
    const results = rankConstituentCoverage([
      snapshot("VOO", ["TCS", "OTHER"]), snapshot("XLK", ["TCS", "HCL"]),
    ], new Map([["TCS", "2026-10-20"]]), new Map([["XLK", 0.1], ["VOO", 0.01]]), "2026-10-20");
    expect(results.map(row => row.symbol)).toEqual(["HCL", "OTHER", "TCS"]);
    expect(results[0].context.benchmark).toBe("XLK");
    expect(new Set(results.map(row => row.symbol)).size).toBe(results.length);
  });

  // Explicit opt-in source contract check: public holdings only, no model calls,
  // credentials, trades, DB writes, or historically reconstructed membership.
  it.skipIf(process.env.ETF_SOURCE_SMOKE !== "1")("reads all eight configured benchmark baskets from public sources", async () => {
    const symbols = ["VOO", "QQQ", "XLK", "XLF", "^NSEI", "ITBEES.NS", "BANKBEES.NS", "JUNIORBEES.NS"];
    const snapshots = await Promise.all(symbols.map(symbol => fetchConstituentSnapshot(symbol)));
    for (let i = 0; i < symbols.length; i++) {
      expect(snapshots[i], symbols[i]).not.toBeNull();
      expect(snapshots[i]!.symbols.length, symbols[i]).toBeGreaterThanOrEqual(10);
    }
    console.log("Verified constituent coverage:", snapshots.map(row => ({ benchmark: row!.benchmark, symbols: row!.symbols.length,
      asOf: row!.asOf, basis: row!.membership })));
  }, 30_000);
});
