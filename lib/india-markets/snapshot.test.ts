import { describe, expect, it } from "vitest";
import { buildSnapshot, computeBreadth, INDEX_SYMBOLS, SECTOR_SYMBOLS } from "@/lib/india-markets/snapshot";
import { NIFTY50_UNIVERSE } from "@/lib/india-markets/constituents";
import type { AdapterQuote } from "@/lib/india-markets/adapter";

const NOW = "2026-07-15T10:30:00.000Z";

function ok(symbol: string, changePct: number): AdapterQuote {
  return { symbol, ok: true, price: 100, changePct, observedAt: NOW, quality: "fresh", source: "yahoo", reasonCode: "ok" };
}
function bad(symbol: string, reasonCode: AdapterQuote["reasonCode"] = "no_data"): AdapterQuote {
  return { symbol, ok: false, price: null, changePct: null, observedAt: null, quality: "stale", source: "yahoo", reasonCode };
}

const allIndices = INDEX_SYMBOLS.map((s) => ok(s, 1));
const allSectors = SECTOR_SYMBOLS.map((s) => ok(s, -0.5));

describe("computeBreadth — honest coverage accounting", () => {
  it("counts advanced/declined/unchanged over resolved names only", () => {
    const quotes = NIFTY50_UNIVERSE.symbols.map((s, i) =>
      i < 30 ? ok(s, 1) : i < 45 ? ok(s, -1) : ok(s, 0),
    );
    const b = computeBreadth(quotes);
    expect(b.eligibleN).toBe(50);
    expect(b.resolvedN).toBe(50);
    expect(b.advanced).toBe(30);
    expect(b.declined).toBe(15);
    expect(b.unchanged).toBe(5);
    expect(b.unavailable).toBe(0);
    expect(b.coveragePct).toBe(100);
    expect(b.quality).toBe("complete");
  });

  it("unresolved names stay in the denominator and drop quality below the floor", () => {
    const quotes = NIFTY50_UNIVERSE.symbols.map((s, i) => (i < 20 ? ok(s, 1) : bad(s, "throttled")));
    const b = computeBreadth(quotes);
    expect(b.resolvedN).toBe(20);
    expect(b.unavailable).toBe(30);
    expect(b.coveragePct).toBe(40);
    expect(b.quality).toBe("partial"); // below 80% floor
  });

  it("ignores duplicate and out-of-universe rows so coverage cannot exceed 100%", () => {
    const quotes = NIFTY50_UNIVERSE.symbols.map((s) => ok(s, 1));
    quotes.push(ok(NIFTY50_UNIVERSE.symbols[0], -1), ok("NOT-IN-NIFTY.NS", 1));
    const b = computeBreadth(quotes);
    expect(b.resolvedN).toBe(50);
    expect(b.advanced).toBe(50);
    expect(b.declined).toBe(0);
    expect(b.coveragePct).toBe(100);
  });
});

describe("buildSnapshot — product status honesty", () => {
  it("complete: all indices+sectors resolved and breadth complete", () => {
    const breadth = computeBreadth(NIFTY50_UNIVERSE.symbols.map((s) => ok(s, 1)));
    const snap = buildSnapshot({ indexQuotes: allIndices, sectorQuotes: allSectors, breadth, now: NOW });
    expect(snap.status).toBe("complete");
    expect(snap.currency).toBe("INR");
    expect(snap.market).toBe("india");
    expect(snap.indices).toHaveLength(INDEX_SYMBOLS.length);
    expect(snap.unavailable).toHaveLength(0);
  });

  it("partial: a missing sector yields partial + an unavailable entry, no fake total", () => {
    const sectors = allSectors.slice(1).concat(bad(SECTOR_SYMBOLS[0], "http_error"));
    const breadth = computeBreadth(NIFTY50_UNIVERSE.symbols.map((s) => ok(s, 1)));
    const snap = buildSnapshot({ indexQuotes: allIndices, sectorQuotes: sectors, breadth, now: NOW });
    expect(snap.status).toBe("partial");
    expect(snap.sectors).toHaveLength(SECTOR_SYMBOLS.length - 1);
    expect(snap.unavailable.some((u) => u.component.startsWith("sector:"))).toBe(true);
  });

  it("partial: breadth null adds an awaiting-fill unavailable entry", () => {
    const snap = buildSnapshot({ indexQuotes: allIndices, sectorQuotes: allSectors, breadth: null, now: NOW });
    expect(snap.status).toBe("partial");
    expect(snap.breadth).toBeNull();
    expect(snap.unavailable.some((u) => u.component === "breadth" && u.reasonCode === "awaiting_scheduled_fill")).toBe(true);
  });

  it("unavailable: no index rows resolve at all", () => {
    const snap = buildSnapshot({
      indexQuotes: INDEX_SYMBOLS.map((s) => bad(s, "network_error")),
      sectorQuotes: SECTOR_SYMBOLS.map((s) => bad(s, "network_error")),
      breadth: null,
      now: NOW,
    });
    expect(snap.status).toBe("unavailable");
    expect(snap.indices).toHaveLength(0);
  });

  it("never emits a provider hostname or raw payload in the snapshot", () => {
    const breadth = computeBreadth(NIFTY50_UNIVERSE.symbols.map((s) => ok(s, 1)));
    const snap = buildSnapshot({ indexQuotes: allIndices, sectorQuotes: allSectors, breadth, now: NOW });
    const json = JSON.stringify(snap);
    expect(json).not.toContain("yahoo.com");
    expect(json).not.toContain("query1");
    expect(json).not.toContain("http");
  });
});
