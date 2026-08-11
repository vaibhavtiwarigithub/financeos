// India price.daily_bars adapters + the market-scoping they depend on.
//
// The headline risk in this change is NOT that India gains bars — it is that
// adding adapters to a shared chain silently alters the US chain, which is
// currently the only market with a clean cohort trend. The first describe block
// exists to make that regression impossible to land quietly.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/data/upstox", () => ({
  fetchUpstoxCandles: vi.fn(async () => []),
}));
vi.mock("@/lib/data/yahoo-candles", () => ({
  fetchYahooCandles: vi.fn(async () => []),
}));

import { adaptersForIntent, PROVIDER_SPECS } from "@/lib/evidence/registry";
import { upstoxBarsAdapter, yahooIndiaBarsAdapter } from "@/lib/evidence/adapters/india-bars";
import { makeBarsAdapter, MIN_BARS, type CanonicalDailyBars } from "@/lib/evidence/adapters/bars";
import type { Candle } from "@/lib/data/technicals";

const bars = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
    open: 100, high: 101, low: 99, close: 100, volume: 1_000,
  }));

describe("market scoping — US chain must be untouched", () => {
  it("gives US exactly its original bars chain, with no India source added", () => {
    const us = adaptersForIntent("price.daily_bars", "us").map(a => a.providerId);
    expect(us).toEqual(["kairos", "massive", "eodhd", "twelvedata"]);
    // Yahoo serves US fundamentals, so a provider-level capability list would
    // have leaked it into the US bars chain. It must not be here.
    expect(us).not.toContain("yahoo");
    expect(us).not.toContain("upstox");
  });

  it("gives India the bridge plus a native chain", () => {
    const india = adaptersForIntent("price.daily_bars", "india").map(a => a.providerId);
    expect(india).toEqual(["kairos", "upstox", "yahoo"]);
    // US-only sources must not appear for India.
    expect(india).not.toContain("massive");
    expect(india).not.toContain("eodhd");
    expect(india).not.toContain("twelvedata");
  });

  it("still filters by provider spec when an adapter declares no markets", () => {
    // massiveBarsAdapter has no adapter-level markets; it is US-only purely by
    // its provider spec. Removing the spec fallback would silently widen it.
    expect(PROVIDER_SPECS.massive?.markets).toEqual(["us"]);
    expect(adaptersForIntent("price.daily_bars", "india").map(a => a.providerId)).not.toContain("massive");
  });
});

describe("India bars semantics", () => {
  it("declares the UNADJUSTED basis the legacy India path actually produces", async () => {
    // Legacy calls fetchYahooCandles(symbol) with no options => raw closes.
    // Claiming adjusted:true here would be a hard §4 parity mismatch.
    for (const adapter of [upstoxBarsAdapter, yahooIndiaBarsAdapter]) {
      const canonical = adapter.toCanonical({ ok: true, payload: { bars: bars(20) } });
      expect((canonical.payload as CanonicalDailyBars).adjusted).toBe(false);
    }
  });

  it("tags INR so a currency swap cannot pass as a numeric difference", () => {
    for (const adapter of [upstoxBarsAdapter, yahooIndiaBarsAdapter]) {
      const canonical = adapter.toCanonical({ ok: true, payload: { bars: bars(20) } });
      expect((canonical.payload as CanonicalDailyBars).currency).toBe("INR");
      expect(canonical.provenance[0]?.currency).toBe("INR");
    }
  });

  it("keeps US adapters on the adjusted basis by default", () => {
    const usLike = makeBarsAdapter({
      providerId: "massive", contractVersion: "t", fetchCandles: async () => bars(20),
    });
    const canonical = usLike.toCanonical({ ok: true, payload: { bars: bars(20) } });
    expect((canonical.payload as CanonicalDailyBars).adjusted).toBe(true);
    expect((canonical.payload as CanonicalDailyBars).currency).toBeUndefined();
  });

  it("names the true serving provider, never a nominal one", () => {
    expect(upstoxBarsAdapter.toCanonical({ ok: true, payload: { bars: bars(20) } }).provenance[0]?.providerId).toBe("upstox");
    expect(yahooIndiaBarsAdapter.toCanonical({ ok: true, payload: { bars: bars(20) } }).provenance[0]?.providerId).toBe("yahoo");
  });

  it("lets the adapter own Upstox pacing and the router own Yahoo's", () => {
    // fetchUpstoxCandles goes through providerCachedFetch (takes its own lease);
    // fetchYahooCandles uses a plain fetch and takes none.
    expect(upstoxBarsAdapter.pacingOwner).toBe("adapter");
    expect(yahooIndiaBarsAdapter.pacingOwner).toBe("router");
  });
});

describe("India bars validation", () => {
  it("rejects a payload claiming a different source", () => {
    const r = upstoxBarsAdapter.validate({ bars: bars(20), source: "yahoo" });
    expect(r.ok).toBe(false);
    expect(r.unavailableReason).toBe("schema_invalid");
  });

  it("treats a sliver of bars as no-data rather than usable evidence", async () => {
    const short = makeBarsAdapter({
      providerId: "upstox", contractVersion: "t",
      fetchCandles: async () => bars(MIN_BARS - 1),
      markets: ["india"], adjusted: false, currency: "INR",
    });
    const r = await short.fetch({ intent: "price.daily_bars", symbol: "RELIANCE.NS", market: "india" } as any, {} as any);
    expect(r.ok).toBe(false);
    expect(r.unavailableReason).toBe("genuine_no_data");
  });

  it("reports an empty series as no-data and never reaches for another provider", async () => {
    const r = await upstoxBarsAdapter.fetch(
      { intent: "price.daily_bars", symbol: "RELIANCE.NS", market: "india" } as any, {} as any,
    );
    // The mocked fetchUpstoxCandles returns [] — the adapter must decline and
    // leave the fallback decision to the router.
    expect(r.ok).toBe(false);
    expect(r.unavailableReason).toBe("genuine_no_data");
  });
});
