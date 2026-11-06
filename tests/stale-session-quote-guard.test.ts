import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { quoteIsFromSession } from "@/lib/paper/quote-crosscheck";

// Incident 2026-11-03..06: the US position monitor wrote the PREVIOUS session's close as a "fresh" mark (observed_at 24.2h old,
// stale=false) because the Yahoo US freshness window is 36h. Four consecutive paper NAVs were one session stale.
describe("quoteIsFromSession", () => {
  it("rejects a quote the exchange stamped on the previous session (the 2026-11-06 MSFT mark)", () => {
    expect(quoteIsFromSession("2026-11-05T21:00:01Z", "us", "2026-11-06")).toBe(false);
  });
  it("accepts the current session's close", () => {
    expect(quoteIsFromSession("2026-11-06T21:00:01Z", "us", "2026-11-06")).toBe(true);
  });
  it("uses the exchange calendar date, not UTC: 01:30Z on Nov 7 is still Nov 6 in New York", () => {
    expect(quoteIsFromSession("2026-11-07T01:30:00Z", "us", "2026-11-06")).toBe(true);
    expect(quoteIsFromSession("2026-11-07T01:30:00Z", "us", "2026-11-07")).toBe(false);
  });
  it("handles both sides of the DST change (EDT close 20:00Z, EST close 21:00Z)", () => {
    expect(quoteIsFromSession("2026-10-30T20:00:01Z", "us", "2026-10-30")).toBe(true);
    expect(quoteIsFromSession("2026-11-02T21:00:01Z", "us", "2026-11-02")).toBe(true);
    expect(quoteIsFromSession("2026-10-30T20:00:01Z", "us", "2026-11-02")).toBe(false);
  });
  it("applies the same rule in India (15:30 IST = 10:00Z)", () => {
    expect(quoteIsFromSession("2026-11-06T10:00:00Z", "india", "2026-11-06")).toBe(true);
    expect(quoteIsFromSession("2026-11-05T10:00:00Z", "india", "2026-11-06")).toBe(false);
  });
  it("fails closed on a missing or unparseable timestamp", () => {
    expect(quoteIsFromSession(null, "us", "2026-11-06")).toBe(false);
    expect(quoteIsFromSession("not a date", "us", "2026-11-06")).toBe(false);
  });
});

describe("settlement quote wiring", () => {
  // The route file is CRLF on disk; normalize so multi-line assertions are line-ending independent.
  const monitor = readFileSync("app/api/agents/position-monitor/route.ts", "utf8").split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  const quotes = readFileSync("lib/data/quotes.ts", "utf8");
  const india = readFileSync("lib/india-data.ts", "utf8");
  const settle = readFileSync("app/api/agents/settle-check/route.ts", "utf8");

  it("the monitor drops any quote from an earlier session before marks and exits", () => {
    expect(monitor).toContain("quoteIsFromSession(quoteMeta[sym]?.observedAt ?? null, symMarket, expectedSession)");
    expect(monitor).toContain("delete priceMap[sym];\n      delete quoteMeta[sym];");
  });
  it("settlement quotes bypass the Next data cache", () => {
    expect(india).toContain('cache: "no-store"');
    expect(quotes).toContain("{ fresh: true }");
    expect(monitor).toContain('fetchYahooQuotes(unresolvedUs, "us", 4, 250, { fresh: true })');
  });
  it("the settled-bar Yahoo branch requires the expected session", () => {
    expect(quotes).toContain('quoteIsFromSession(q.retrievedAt, "us", session)');
  });
  it("settle-check judges the latest mark per position so a retry supersedes an earlier run", () => {
    expect(settle).toContain("latestPerPosition");
  });
});
