import { describe, expect, it } from "vitest";
import { assessSeries, assertFreshBar, isFreshSessionDate } from "@/lib/data/price-cache-freshness";

describe("price-cache freshness", () => {
  const now = new Date("2026-08-16T18:00:00.000Z"); // Saturday: Friday is the completed US session.

  it("accepts the last completed session and rejects an older cache row", () => {
    expect(isFreshSessionDate("2026-08-14", "us", now)).toBe(true);
    expect(isFreshSessionDate("2026-08-13", "us", now)).toBe(false);
    expect(assertFreshBar({ date: "2026-08-13", close: 100 }, "TEST", "us", now)).toMatchObject({ ok: false, reason: "quote_stale" });
  });

  it("requires both sufficient coverage and a fresh final session", () => {
    const stale = Array.from({ length: 20 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, "0")}`, close: 100 + i }));
    expect(assessSeries(stale, { symbol: "TEST", market: "us", minBars: 15, now })).toMatchObject({ ok: false, reason: "stale_series" });
    expect(assessSeries([{ date: "2026-08-14", close: 100 }], { symbol: "TEST", market: "us", minBars: 15, now })).toMatchObject({ ok: false, reason: "insufficient_coverage" });
  });
});
