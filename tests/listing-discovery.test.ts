import { describe, expect, it } from "vitest";
import { candidateRowForFiling, candidateStateForFiling, isListingObservationEntryEligible, selectUnambiguousIdentityForCik, stateAfterVerifiedFirstTrade } from "@/lib/listings/discovery";
import { edgarDailyIndexUrl, parseEdgarMasterIndex, parseSecCurrentIssuerListings, publishedEdgarIndexDates, collectEdgarIndexes } from "@/lib/listings/sec-edgar";
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

// REAL format (live SEC fetch of master.20260930.idx, 2026-10-03): dates are YYYYMMDD, not ISO. The parser rejected
// every such row, so listing discovery reported "available, 0 filings" daily and created no candidate (that index had
// 12 S-1/F-1/424B4 filings). The ISO-date fixture above hid it.
const REAL_INDEX = `Description:           Daily Index of EDGAR Dissemination Feed
Last Data Received:    Sep 30, 2026
Comments:              webmaster@sec.gov
Anonymous FTP:         ftp://ftp.sec.gov/edgar/

CIK|Company Name|Form Type|Date Filed|File Name
--------------------------------------------------------------------------------
1000275|ROYAL BANK OF CANADA|424B2|20260930|edgar/data/1000275/0000950103-26-014800.txt
2012345|NEW LISTING HOLDINGS INC|S-1|20260930|edgar/data/2012345/0001193125-26-400001.txt
2012346|FOREIGN NEWCO LTD|F-1/A|20260930|edgar/data/2012346/0001193125-26-400002.txt
2012347|PRICED IPO CORP|424B4|20260930|edgar/data/2012347/0001193125-26-400003.txt
`;

describe("SEC daily index real date format", () => {
  it("parses YYYYMMDD dates, keeps only IPO forms and normalizes filedAt to ISO", () => {
    const rows = parseEdgarMasterIndex(REAL_INDEX);
    expect(rows.map((row) => row.form)).toEqual(["S-1", "F-1/A", "424B4"]);
    expect(rows.every((row) => row.filedAt === "2026-09-30")).toBe(true);
    expect(rows[0]).toMatchObject({ cik: "0002012345", accessionNumber: "0001193125-26-400001" });
  });
  it("still accepts ISO dates and rejects a malformed date", () => {
    expect(parseEdgarMasterIndex(INDEX)).toHaveLength(2);
    const bad = REAL_INDEX.replace("20260930|edgar/data/2012345", "2026-9-30|edgar/data/2012345");
    expect(parseEdgarMasterIndex(bad).map((row) => row.form)).toEqual(["F-1/A", "424B4"]);
  });
});

describe("new-listing evidence discovery", () => {
  it("resolves current issuer tickers by SEC CIK without inventing a first-trade date", () => {
    const rows = parseSecCurrentIssuerListings({
      fields: ["cik", "name", "ticker", "exchange"],
      data: [[1181412, "Space Exploration Technologies Corp.", "SPCX", "Nasdaq"], ["bad", "Invalid", "???", "Nasdaq"]],
    });
    expect(rows).toEqual([{ cik: "0001181412", companyName: "Space Exploration Technologies Corp.", symbol: "SPCX", exchange: "Nasdaq" }]);
    expect(() => parseSecCurrentIssuerListings({ fields: ["bad"], data: [] })).toThrow(/expected columns/i);
    expect(selectUnambiguousIdentityForCik(rows, "1181412").identity?.symbol).toBe("SPCX");
    expect(selectUnambiguousIdentityForCik([...rows, { ...rows[0], symbol: "SPCX.B" }], "1181412")).toEqual({ identity: null, ambiguous: true });
  });

  it("keeps newly-listed observation research permanently outside the entry-eligible cohort", () => {
    expect(isListingObservationEntryEligible("new_listing_observation", true)).toBe(false);
    expect(isListingObservationEntryEligible("screener_momentum", true)).toBe(true);
    expect(isListingObservationEntryEligible("new_listing_observation", false)).toBe(false);
  });

  it("advances only pre-listing states; verified backfills never downgrade terminal/admitted states", () => {
    expect(stateAfterVerifiedFirstTrade("announced")).toBe("listed_observing");
    expect(stateAfterVerifiedFirstTrade("paper_admitted")).toBe("paper_admitted");
    expect(stateAfterVerifiedFirstTrade("delisted")).toBe("delisted");
  });

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
