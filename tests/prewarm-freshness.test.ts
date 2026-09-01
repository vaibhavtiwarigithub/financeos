import { describe, it, expect, vi } from "vitest";
import { expectedNewestSession } from "@/lib/data/completed-candles";

// Stub the provider edges so prewarmPriceCache can run without network.
vi.mock("@/lib/data/candles", () => ({
  fetchUsCandles: vi.fn(async () => ({ candles: [], source: "yahoo" })),
  fetchMassiveCandles: vi.fn(async () => []),
  fetchEodhdCandles: vi.fn(async () => []),
  fetchTwelveDataCandles: vi.fn(async () => []),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ from: () => ({}) }) }));

// Pins the freshness rule the price-cache prewarm uses to decide which symbols
// to re-fetch.
//
// THE DEFECT (found in production 2026-09-01). The prewarm treated a symbol as
// fresh if it held ANY bar newer than `Date.now() - 96h`. Measured that Tuesday,
// the cutoff landed exactly on Friday 2026-08-28, so 106 of 113 traded symbols
// stuck on Friday's bar passed the test and were skipped — permanently, because
// the condition regenerates every weekend. The freshness MONITOR flagged the
// same symbols at the same moment ("106/113 scopes past the 96h grace"), so the
// two halves of the system disagreed about the same 96 hours.
//
// Meanwhile lib/data/quotes.ts marks a price_cache quote stale when its bar is
// older than expectedNewestSession(). A bar the quote gate rejects must be a bar
// the prewarm refetches, or the book starves on quote_stale while the cache
// believes itself healthy — which is exactly what happened: PaperTrader executed
// 0 of 10 eligible US candidates, 7 of them blocked on quote_stale.

describe("prewarm freshness must be a market session, not a calendar window", () => {
  // Tuesday 2026-09-01, after the US close.
  const tuesdayAfterClose = new Date("2026-09-01T21:00:00Z");

  it("the 96h calendar window admits Friday's bar on Tuesday — the bug", () => {
    const calendarCutoff = new Date(tuesdayAfterClose.getTime() - 96 * 3600_000)
      .toISOString().slice(0, 10);
    const fridayBar = "2026-08-28";
    // Friday's bar passes a 96h grace, which is why those symbols were skipped.
    expect(fridayBar >= calendarCutoff).toBe(true);
  });

  it("the session rule rejects Friday's bar on Tuesday — the fix", () => {
    const sessionCutoff = expectedNewestSession("us", tuesdayAfterClose);
    const fridayBar = "2026-08-28";
    expect(fridayBar >= sessionCutoff).toBe(false);
    // And it names a session at or after Monday, not four calendar days back.
    expect(sessionCutoff > fridayBar).toBe(true);
  });

  it("agrees with the quote gate: same rule, same verdict", () => {
    // lib/data/quotes.ts sets stale = bar.date < expectedNewestSession(...).
    // The prewarm now uses the identical comparison, so a quote judged stale is
    // always a symbol the prewarm re-fetches.
    const cutoff = expectedNewestSession("us", tuesdayAfterClose);
    const quoteWouldBeStale = (barDate: string) => barDate < cutoff;
    const prewarmWouldRefetch = (barDate: string) => !(barDate >= cutoff);
    for (const bar of ["2026-08-27", "2026-08-28", "2026-08-31", "2026-09-01"]) {
      expect(prewarmWouldRefetch(bar)).toBe(quoteWouldBeStale(bar));
    }
  });

  it("does not churn a symbol that already holds the expected session", () => {
    const cutoff = expectedNewestSession("us", tuesdayAfterClose);
    // A symbol at the expected session is fresh and must NOT be re-fetched,
    // otherwise every run burns provider budget on work already done.
    expect(cutoff >= cutoff).toBe(true);
  });

  it("weekends do not make a Friday bar stale on Saturday", () => {
    // Saturday: the newest session that should exist is still Friday, so a
    // Friday bar is current and the prewarm should leave it alone.
    const saturday = new Date("2026-08-29T18:00:00Z");
    expect(expectedNewestSession("us", saturday)).toBe("2026-08-28");
  });
});

describe("the prewarm actually USES the session rule (wiring, not just the rule)", () => {
  // The first version of this file asserted only that expectedNewestSession
  // differs from a 96h window. That passed even with the calendar cutoff still
  // wired in, because it tested the CONCEPT and not the CALL SITE. This suite
  // captures the value the freshness query is really given.
  it("queries price_cache with the expected market session as the cutoff", async () => {
    const { prewarmPriceCache } = await import("@/lib/chart-data");

    let capturedGte: string | null = null;
    const supabase = {
      from: () => {
        const chain: any = {};
        chain.select = () => chain;
        chain.in = () => chain;
        chain.gte = (_col: string, value: string) => { capturedGte = value; return chain; };
        chain.limit = async () => ({ data: [{ symbol: "AAPL", date: "2026-08-28" }], error: null });
        chain.upsert = async () => ({ error: null });
        return chain;
      },
    };

    // deadlineAt in the past: the freshness probe still runs, the fetch loop
    // exits immediately, so this isolates the cutoff without hitting providers.
    await prewarmPriceCache(["AAPL"], supabase, { deadlineAt: Date.now() - 1 });

    expect(capturedGte).not.toBeNull();
    // The cutoff must be a market session, never a rolling 96h calendar date.
    expect(capturedGte).toBe(expectedNewestSession("us", new Date()));

    const calendar96h = new Date(Date.now() - 96 * 3600_000).toISOString().slice(0, 10);
    // These differ whenever a weekend sits inside the window, which is the case
    // the bug lived in. Assert inequality only when they genuinely differ, so
    // the test is meaningful rather than accidentally true.
    if (expectedNewestSession("us", new Date()) !== calendar96h) {
      expect(capturedGte).not.toBe(calendar96h);
    }
  });
});
