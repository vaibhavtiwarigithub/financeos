import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { candidateRowForFiling, candidateStateForFiling, isListingObservationEntryEligible, selectUnambiguousIdentityForCik, stateAfterVerifiedFirstTrade } from "@/lib/listings/discovery";
import { edgarDailyIndexUrl, parseEdgarMasterIndex, parseSecCurrentIssuerListings, publishedEdgarIndexDates, collectEdgarIndexes } from "@/lib/listings/sec-edgar";
import { capability, preflightRow } from "@/lib/brokers/preflight";
import { parseUsSymbolDirectory } from "@/lib/listings/us-symbol-directory";

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

describe("daily US symbol-directory discovery contract", () => {
  function directories(date = "1007202621:31", extraOther = "") {
    const nasdaqRows = Array.from({ length: 4000 }, (_, i) => `N${String(i).padStart(4, "0")}|Example Corp ${i} - Common Stock|Q|N|N|100|N|`).join("\n");
    const otherRows = Array.from({ length: 5000 }, (_, i) => `O${String(i).padStart(4, "0")}|Example Listed Corp ${i} - Common Stock|N|O${String(i).padStart(4, "0")}|N|100|N|`).join("\n");
    return {
      nasdaq: `Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares\n${nasdaqRows}\nFile Creation Time: ${date}`,
      other: `ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol\n${otherRows}\n${extraOther}\nFile Creation Time: ${date}`,
    };
  }

  it("requires both complete directory files and a shared fresh source date", () => {
    const files = directories();
    const parsed = parseUsSymbolDirectory(files.nasdaq, files.other, new Date("2026-10-07T23:00:00Z"));
    expect(parsed).toMatchObject({ sourceAsOf: "2026-10-07", nasdaqRows: 4000, otherRows: 5000 });
    expect(parsed.listingKeys).toHaveLength(9000);
    expect(() => parseUsSymbolDirectory(files.nasdaq.replace("Financial Status", "Status"), files.other, new Date("2026-10-07T23:00:00Z"))).toThrow(/header/i);
    const mismatch = directories("1006202621:31");
    expect(() => parseUsSymbolDirectory(files.nasdaq, mismatch.other, new Date("2026-10-07T23:00:00Z"))).toThrow(/mismatched/i);
  });

  it("classifies only supported research instruments and fails closed on unknown exchanges", () => {
    const files = directories("1007202621:31", [
      "TEST|Test ETF|N|TEST|Y|100|N|", "BAD|Example Warrant|N|BAD|N|100|N|", "UNK|Mystery Corporation|N|UNK|N|100|N|",
      "ADR|Example American Depositary Shares|F|ADR|N|100|N|", "TXSE|Example common shares|M|TXSE|N|100|N|",
    ].join("\n"));
    const parsed = parseUsSymbolDirectory(files.nasdaq, files.other, new Date("2026-10-07T23:00:00Z"));
    expect(parsed.researchable.find(row => row.symbol === "ADR")).toMatchObject({ exchange: "TXSE", instrumentType: "adr" });
    expect(parsed.researchable.find(row => row.symbol === "TXSE")).toMatchObject({ exchange: "NYSE Texas", instrumentType: "operating_company" });
    expect(parsed.researchable.some(row => row.symbol === "BAD")).toBe(false);
    expect(parsed.researchable.some(row => row.symbol === "UNK")).toBe(false);
    expect(() => parseUsSymbolDirectory(files.nasdaq, files.other.replace("|F|ADR|N|100|N|", "|X|ADR|N|100|N|"), new Date("2026-10-07T23:00:00Z"))).toThrow(/unsupported exchange/i);
  });

  it("rejects stale snapshots rather than silently advancing the baseline", () => {
    const files = directories("0925202621:31");
    expect(() => parseUsSymbolDirectory(files.nasdaq, files.other, new Date("2026-10-07T23:00:00Z"))).toThrow(/freshness/i);
  });

  it("wires directory persistence and candidate rotation without creating a trading path", () => {
    const migration = readFileSync("supabase/migrations/20261008042552_us_symbol_directory_research_cycle.sql", "utf8");
    const collector = readFileSync("app/api/agents/listing-discovery/route.ts", "utf8");
    const research = readFileSync("lib/research-agent.ts", "utf8");
    const cron = readFileSync("app/api/agents/research/cron/route.ts", "utf8");
    expect(migration).toContain("directory_observed");
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("revoke all on public.us_symbol_directory_snapshot from public, anon, authenticated");
    expect(collector.lastIndexOf('from("us_symbol_directory_snapshot").upsert({ id: "us"')).toBeGreaterThan(collector.indexOf('from("listing_candidate_events").upsert'));
    expect(research).toContain('["directory_observed", "listed_observing"]');
    expect(research).toContain('order("last_research_attempt_at", { ascending: true, nullsFirst: true })');
    expect(research).toContain('RESEARCH_NEW_LISTING_OBSERVATIONS_PER_RUN');
    expect(cron).toContain("forceEntryIneligible: true");
    expect(cron).toContain('"new_listing_observation"]');
    expect(cron).toContain(': marketEntries.filter(e => e.discovery_source !== "new_listing_observation")');
    expect(cron).toContain("last_research_attempt_at: new Date().toISOString()");
  });
});
