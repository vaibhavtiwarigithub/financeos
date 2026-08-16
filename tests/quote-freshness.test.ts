import { describe, it, expect } from "vitest";
import { assertFreshQuote } from "@/lib/data/quote-freshness";

const nowIso = () => new Date().toISOString();
const daysAgoIso = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

describe("assertFreshQuote — the money-path boundary", () => {
  it("accepts a fresh, fully-attributed quote and returns its provenance", () => {
    const v = assertFreshQuote(
      { price: 45.28, source: "massive", retrievedAt: nowIso(), stale: false },
      "LNC",
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.price).toBe(45.28);
      expect(v.source).toBe("massive");
      // provenance must survive — reconstructing it later is what made the
      // 2026-08 incident unattributable
      expect(Date.parse(v.retrievedAt)).toBeGreaterThan(0);
    }
  });

  // The actual production incident: LNC filled at 35.39 off a price_cache row
  // from 2026-05-26 while it really traded at 45.28.
  it("REJECTS the LNC regression — a stale price_cache quote", () => {
    const v = assertFreshQuote(
      { price: 35.3724, source: "price_cache", retrievedAt: daysAgoIso(79), stale: true },
      "LNC",
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("quote_stale");
      expect(v.detail).toContain("price_cache");
      expect(v.detail).toContain("LNC");
    }
  });

  it("treats a MISSING stale flag as stale, never as an all-clear", () => {
    const v = assertFreshQuote(
      { price: 100, source: "massive", retrievedAt: nowIso() }, // no `stale`
      "AAPL",
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("quote_stale");
  });

  it("rejects unavailable, zero, negative and absent quotes", () => {
    for (const q of [
      { price: 100, source: "unavailable", retrievedAt: nowIso(), stale: false },
      { price: 0, source: "massive", retrievedAt: nowIso(), stale: false },
      { price: -5, source: "massive", retrievedAt: nowIso(), stale: false },
      null,
    ]) {
      const v = assertFreshQuote(q as any, "X");
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe("price_unavailable");
    }
  });

  it("rejects a quote it cannot attribute", () => {
    const noSource = assertFreshQuote({ price: 10, source: "", retrievedAt: nowIso(), stale: false }, "X");
    expect(noSource.ok).toBe(false);
    if (!noSource.ok) expect(noSource.reason).toBe("quote_provenance_missing");

    const noStamp = assertFreshQuote({ price: 10, source: "massive", retrievedAt: "", stale: false }, "X");
    expect(noStamp.ok).toBe(false);
    if (!noStamp.ok) expect(noStamp.reason).toBe("quote_provenance_missing");
  });

  it("rejects unparseable and future-dated timestamps", () => {
    const bad = assertFreshQuote({ price: 10, source: "massive", retrievedAt: "not-a-date", stale: false }, "X");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("quote_timestamp_invalid");

    const future = assertFreshQuote(
      { price: 10, source: "massive", retrievedAt: new Date(Date.now() + 3600_000).toISOString(), stale: false },
      "X",
    );
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.reason).toBe("quote_timestamp_invalid");
  });

  it("fails closed: every rejection carries a reason and a symbol-bearing detail", () => {
    const cases = [
      null,
      { price: 1, source: "price_cache", retrievedAt: daysAgoIso(30), stale: true },
      { price: 1, source: "massive", retrievedAt: "garbage", stale: false },
    ];
    for (const q of cases) {
      const v = assertFreshQuote(q as any, "SYM");
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.reason).toBeTruthy();
        expect(v.detail).toContain("SYM");
      }
    }
  });
});
