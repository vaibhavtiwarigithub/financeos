import { describe, expect, it } from "vitest";
import { candidateRowForFiling, candidateStateForFiling } from "@/lib/listings/discovery";
import { edgarDailyIndexUrl, parseEdgarMasterIndex, publishedEdgarIndexDates, collectEdgarIndexes } from "@/lib/listings/sec-edgar";
import { capability, preflightRow } from "@/lib/brokers/preflight";

// Header matches SEC's real format (space in "File Name"), confirmed against
// a live fetch 2026-09-24 -- the fixture previously used "Filename" (no
// space), the same wrong string the production code searched for, so this
// test passed while masking a real bug that broke every production run.
const INDEX = `Description: Master Index of EDGAR Dissemination Feed
CIK|Company Name|Form Type|Date Filed|File Name
--------------------------------------------------------------------------------
0002000001|Example Issuer Inc|S-1|2026-09-08|edgar/data/2000001/0002000001-26-000001.txt
0002000002|Already Listed Inc|10-K|2026-09-08|edgar/data/2000002/0002000002-26-000002.txt
0002000003|Foreign Issuer|F-1/A|2026-09-08|edgar/data/2000003/0002000003-26-000003.txt
`;

describe("new-listing evidence discovery", () => {
  it("never requests tonight's not-yet-published index", () => {
    expect(publishedEdgarIndexDates(new Date("2026-09-25T23:35:00Z"))[0].toISOString().slice(0, 10)).toBe("2026-09-24");
    expect(publishedEdgarIndexDates(new Date("2026-09-26T08:35:00Z"))[0].toISOString().slice(0, 10)).toBe("2026-09-25");
    expect(publishedEdgarIndexDates(new Date("2026-09-26T06:00:00Z"))[0].toISOString().slice(0, 10)).toBe("2026-09-24");
  });
  it("preserves available filings when another index is unavailable", async () => {
    const result = await collectEdgarIndexes(new Date("2026-09-26T08:35:00Z"), async date => {
      if (date.getUTCDate() === 25) throw new Error("403");
      return parseEdgarMasterIndex(INDEX);
    });
    expect(result.map(r => r.status)).toEqual(["unavailable", "available", "available"]);
    expect(result[1].filings).toHaveLength(2);
  });
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
