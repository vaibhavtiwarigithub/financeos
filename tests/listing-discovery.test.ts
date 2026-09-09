import { describe, expect, it } from "vitest";
import { candidateRowForFiling, candidateStateForFiling } from "@/lib/listings/discovery";
import { edgarDailyIndexUrl, parseEdgarMasterIndex } from "@/lib/listings/sec-edgar";
import { capability, preflightRow } from "@/lib/brokers/preflight";

const INDEX = `Description: Master Index of EDGAR Dissemination Feed
CIK|Company Name|Form Type|Date Filed|Filename
--------------------------------------------------------------------------------
0002000001|Example Issuer Inc|S-1|2026-09-08|edgar/data/2000001/0002000001-26-000001.txt
0002000002|Already Listed Inc|10-K|2026-09-08|edgar/data/2000002/0002000002-26-000002.txt
0002000003|Foreign Issuer|F-1/A|2026-09-08|edgar/data/2000003/0002000003-26-000003.txt
`;

describe("new-listing evidence discovery", () => {
  it("retains only allowed registration/prospectus forms with immutable SEC identity", () => {
    const filings = parseEdgarMasterIndex(INDEX);
    expect(filings).toHaveLength(2);
    expect(filings[0]).toMatchObject({ cik: "0002000001", form: "S-1", accessionNumber: "0002000001-26-000001" });
    expect(filings[0].sourceUrl).toBe("https://www.sec.gov/Archives/edgar/data/2000001/0002000001-26-000001.txt");
    expect(filings[0].payloadHash).toHaveLength(64);
  });

  it("fails loudly when the SEC format changes instead of reading it as no new listings", () => {
    expect(() => parseEdgarMasterIndex("CIK Company Form\n1 Foo S-1")).toThrow(/column header/i);
  });

  it("does not manufacture a first-trade date from filing discovery", () => {
    const filing = parseEdgarMasterIndex(INDEX)[0];
    const row = candidateRowForFiling(filing, new Date("2026-09-09T12:00:00Z"));
    expect(row.state).toBe("pre_listing");
    expect(row).not.toHaveProperty("first_trade_date");
    expect(row.listing_key).toBe("sec-cik:0002000001");
    expect(candidateStateForFiling("424B4")).toBe("announced");
  });

  it("uses the correct SEC daily-index quarter and UTC date", () => {
    expect(edgarDailyIndexUrl(new Date("2026-09-08T12:00:00Z"))).toBe("https://www.sec.gov/Archives/edgar/daily-index/2026/QTR3/master.20260908.idx");
  });

  it("marks candidate broker evidence separately from an execution attempt", () => {
    const cap = capability({ accountId: "account", symbol: "EXM", side: "buy", qty: 1, type: "market", env: "live" }, {
      broker: "test", market: "us", source: "test", allowed: false,
    });
    expect(preflightRow(cap, null).purpose).toBe("execution_attempt");
    expect(preflightRow(cap, null, "candidate_probe").purpose).toBe("candidate_probe");
  });
});
