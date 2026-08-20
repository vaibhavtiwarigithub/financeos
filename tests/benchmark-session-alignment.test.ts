// W5 detectors.
//
// Production defect being locked out: `bench_nav` 708.42 is VOO's 2026-08-11
// close, and it is stored under BOTH 2026-08-12 and 2026-08-13, because both
// writers accepted any positive benchmark quote and labelled it with the cron's
// run date. These tests fail if any of that behaviour comes back.

import { describe, expect, it } from "vitest";
import {
  benchmarkReturnPct,
  benchmarkSymbol,
  fetchBenchmarkObservation,
  selectBenchmarkObservation,
} from "@/lib/paper/benchmark-observation";

const bar = (date: string, close: number) => ({ date, open: close, high: close, low: close, close, volume: 1 });

// Dates are relative to now, not literals: the daily-bar recency guard is
// wall-clock, so a pinned 2026-08 fixture would silently start failing for the
// wrong reason a week later.
const dayOffset = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const TODAY = dayOffset(0);
const PREV = dayOffset(1);
const PREV2 = dayOffset(2);

// The incident shape: the newest available close is the PREVIOUS session, and
// the writer wanted to stamp it with today's (and then tomorrow's) run date.
// Real numbers: VOO 708.42 was the 2026-08-11 close, stored under 08-12 AND 08-13.
const VOO = [bar(PREV2, 706.55), bar(PREV, 708.42)];

describe("a benchmark observation carries its own session", () => {
  it("returns the bar for the requested session, dated by the bar", () => {
    const r = selectBenchmarkObservation(VOO, "VOO", "yahoo", PREV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.observation).toEqual({ symbol: "VOO", sessionDate: PREV, close: 708.42, source: "yahoo" });
  });

  // THE detector: the exact production defect.
  it("REFUSES to stamp the previous session's close with today's run date", () => {
    const r = selectBenchmarkObservation(VOO, "VOO", "yahoo", TODAY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("benchmark_session_mismatch");
    expect(r.latestSessionDate).toBe(PREV);
    expect(r.detail).toContain(`refusing to store it under ${TODAY}`);
  });

  it("REFUSES it again on the next run rather than repeating the same close", () => {
    const r = selectBenchmarkObservation(VOO, "VOO", "yahoo", dayOffset(-1));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("benchmark_session_mismatch");
  });

  it("never infers the observation date from the run date", () => {
    const r = selectBenchmarkObservation(VOO, "VOO", "yahoo", PREV2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The older bar, not the newest one.
    expect(r.observation.sessionDate).toBe(PREV2);
    expect(r.observation.close).toBe(706.55);
  });

  it("rejects an empty or unusable bar series rather than inventing a level", () => {
    expect(selectBenchmarkObservation([], "VOO", "unavailable", TODAY).ok).toBe(false);
    const junk = [{ date: TODAY, open: 0, high: 0, low: 0, close: 0, volume: 0 }];
    const r = selectBenchmarkObservation(junk, "VOO", "yahoo", TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("benchmark_bars_unavailable");
  });

  it("names a provider stranded in the past as stale, not merely mismatched", () => {
    const stale = [bar("2020-01-02", 300), bar("2020-01-03", 301)];
    const r = selectBenchmarkObservation(stale, "VOO", "yahoo", TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("benchmark_bars_stale");
  });

  it("resolves today's bar when it exists", () => {
    const r = selectBenchmarkObservation([bar(TODAY, 712.34)], "VOO", "yahoo", TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.observation.sessionDate).toBe(TODAY);
  });

  it("keeps the per-market benchmark symbols", () => {
    expect(benchmarkSymbol("us")).toBe("VOO");
    expect(benchmarkSymbol("india")).toBe("^NSEI");
  });
});

describe("benchmark return baseline", () => {
  it("computes vs the first recorded observation", () => {
    expect(benchmarkReturnPct(110, 100)).toBeCloseTo(10, 10);
  });

  it("returns null rather than a fake 0% when there is no baseline", () => {
    expect(benchmarkReturnPct(110, null)).toBeNull();
    expect(benchmarkReturnPct(110, 0)).toBeNull();
  });
});

// ── 2026-08-18: the ladder's recency guard is too weak for an EXACT session ──
//
// Production: on 2026-08-17 the US book recorded NO benchmark while India
// recorded one fine. `fetchUsCandles` accepts the first provider whose newest
// bar is within a generic 4-day guard. Yahoo had not published the settled VOO
// bar 15 minutes after the US close, so its newest was 2026-08-14 — 3 days old,
// therefore "fresh" — and the ladder returned it without ever trying Massive,
// which DID have 2026-08-17 at 710.27. av_cache proves it:
// YAHOO_CANDLES:VOO @ cache_date 2026-08-17 had newest_bar 2026-08-14.
//
// Dates stay RELATIVE, per the note at the top of this file: the stale guard is
// wall-clock, so pinned 2026-08 literals would drift into `stale` and start
// asserting the wrong branch.
describe("US benchmark falls through to the next provider on a session miss", () => {
  const SESSION = dayOffset(0);
  // Yahoo as it actually was: usable bars, newest 3 days old (INSIDE the 4-day
  // guard, so the ladder accepts it), but no bar for the session asked about.
  const yahooShort = [bar(dayOffset(5), 705), bar(dayOffset(4), 708.42), bar(dayOffset(3), 714.95)];

  it("uses the fallback provider's bar when the primary lacks the just-closed session", async () => {
    let fallbackCalls = 0;
    const res = await fetchBenchmarkObservation("us", SESSION, {
      us: async () => ({ candles: yahooShort, source: "yahoo" }),
      usFallback: async () => { fallbackCalls++; return [...yahooShort, bar(SESSION, 710.27)]; },
      india: async () => [],
      indiaCrossCheck: async () => [],
      usQuote: async () => null,
    });

    expect(fallbackCalls).toBe(1);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.observation.sessionDate).toBe(SESSION);
      expect(res.observation.close).toBe(710.27);
      expect(res.observation.source).toBe("massive");
    }
  });

  it("spends NO second call when the primary already has the session", async () => {
    let fallbackCalls = 0;
    const res = await fetchBenchmarkObservation("us", SESSION, {
      us: async () => ({ candles: [...yahooShort, bar(SESSION, 710.27)], source: "yahoo" }),
      usFallback: async () => { fallbackCalls++; return []; },
      india: async () => [],
      indiaCrossCheck: async () => [],
      usQuote: async () => null,
    });
    expect(fallbackCalls).toBe(0);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.observation.source).toBe("yahoo");
  });

  it("a STRANDED provider is not retried — that is a different failure", async () => {
    let fallbackCalls = 0;
    const res = await fetchBenchmarkObservation("us", SESSION, {
      us: async () => ({ candles: [bar(dayOffset(40), 600)], source: "yahoo" }),
      usFallback: async () => { fallbackCalls++; return []; },
      india: async () => [],
      indiaCrossCheck: async () => [],
      usQuote: async () => null,
    });
    expect(fallbackCalls).toBe(0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("benchmark_bars_stale");
  });

  it("when neither provider has the session it still refuses, reporting the ladder's own reason", async () => {
    const res = await fetchBenchmarkObservation("us", SESSION, {
      us: async () => ({ candles: yahooShort, source: "yahoo" }),
      usFallback: async () => yahooShort,
      india: async () => [],
      indiaCrossCheck: async () => [],
      usQuote: async () => null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("benchmark_session_mismatch");
      expect(res.detail).toContain("yahoo");
    }
  });

  it("India never spends the US fallback call", async () => {
    // 2026-08-19: India gained its OWN second source (Upstox), so the source
    // string is no longer a bare "yahoo". The invariant this test exists for is
    // unchanged: the US-only fallback must never be called on the India path.
    let fallbackCalls = 0;
    const res = await fetchBenchmarkObservation("india", SESSION, {
      us: async () => ({ candles: [], source: "none" }),
      usFallback: async () => { fallbackCalls++; return []; },
      india: async () => [bar(SESSION, 24245.7)],
      indiaCrossCheck: async () => [],
      usQuote: async () => null,
    });
    expect(fallbackCalls).toBe(0);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.observation.source).toBe("yahoo(unconfirmed)");
  });
});

// ── India cross-provider check (2026-08-19) ─────────────────────────────────
//
// The exact-session rule validates the DATE, never the VALUE. Yahoo's ^NSEI
// series carries NULL-close bars and briefly serves a PROVISIONAL number on
// those sessions before dropping it. On 2026-08-18 that wrote 24245.699 into
// paper_performance when the settled NIFTY 50 close was 24154.9 — 0.375% wrong,
// and invisible from Yahoo alone because Yahoo agreed with itself. Upstox is a
// broker API carrying official exchange data, so it is the authoritative side.
describe("India benchmark is cross-checked against the exchange source", () => {
  const SESSION = dayOffset(0);
  const f = (yahoo: number | null, upstox: number | null) => ({
    us: async () => ({ candles: [], source: "none" }),
    usFallback: async () => [],
    india: async () => (yahoo == null ? [] : [bar(SESSION, yahoo)]),
    indiaCrossCheck: async () => (upstox == null ? [] : [bar(SESSION, upstox)]),
    usQuote: async () => null,
  });

  it("labels agreement from both providers", async () => {
    const r = await fetchBenchmarkObservation("india", SESSION, f(24154.9, 24154.9));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.observation.source).toBe("upstox+yahoo");
      expect(r.observation.close).toBe(24154.9);
    }
  });

  it("takes the EXCHANGE value and flags the disagreement — the real 2026-08-18 case", async () => {
    const r = await fetchBenchmarkObservation("india", SESSION, f(24245.699, 24154.9));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.observation.close).toBe(24154.9);
      expect(r.observation.source).toBe("upstox(yahoo_disagreed)");
    }
  });

  it("tolerates rounding-scale differences without crying wolf", async () => {
    const r = await fetchBenchmarkObservation("india", SESSION, f(24154.905, 24154.9));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.observation.source).toBe("upstox+yahoo");
  });

  it("still produces a benchmark when only one provider resolves — labelled unconfirmed", async () => {
    const onlyUpstox = await fetchBenchmarkObservation("india", SESSION, f(null, 24154.9));
    expect(onlyUpstox.ok).toBe(true);
    if (onlyUpstox.ok) expect(onlyUpstox.observation.source).toBe("upstox(unconfirmed)");

    const onlyYahoo = await fetchBenchmarkObservation("india", SESSION, f(24245.699, null));
    expect(onlyYahoo.ok).toBe(true);
    if (onlyYahoo.ok) expect(onlyYahoo.observation.source).toBe("yahoo(unconfirmed)");
  });

  it("refuses when neither provider has the session", async () => {
    const r = await fetchBenchmarkObservation("india", SESSION, f(null, null));
    expect(r.ok).toBe(false);
  });

  it("a cross-check outage cannot break the India path", async () => {
    const r = await fetchBenchmarkObservation("india", SESSION, {
      us: async () => ({ candles: [], source: "none" }),
      usFallback: async () => [],
      india: async () => [bar(SESSION, 24154.9)],
      indiaCrossCheck: async () => { throw new Error("upstox 500"); },
      usQuote: async () => null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.observation.source).toBe("yahoo(unconfirmed)");
  });
});

// ── 2026-08-20: the US benchmark could not resolve the just-closed session ──
//
// US bench_nav was NULL two sessions running while NAV itself was correct: at
// 16:15 ET no vendor has published VOO's settled bar (Yahoo chart lacks it,
// Massive grouped publishes next-day, Massive /range ends yesterday). NAV is now
// marked from the 16:15 print, so a 16:15 benchmark is LIKE-FOR-LIKE — pairing a
// 16:15 NAV with a settled close is the greater inconsistency.
describe("US benchmark falls back to the session quote, under a hard guard", () => {
  const TODAY = dayOffset(0);
  // Production shape: Yahoo's chart DOES return a healthy series, it simply ends
  // at the previous session. That is `benchmark_session_mismatch`, which is the
  // ONLY state the quote fallback rescues.
  const sessionMissing = {
    us: async () => ({ candles: [bar(dayOffset(3), 700), bar(dayOffset(2), 702), bar(dayOffset(1), 704)], source: "yahoo" }),
    usFallback: async () => [] as any,
    india: async () => [] as any,
    indiaCrossCheck: async () => [] as any,
  };

  it("uses the quote when no vendor has the just-closed session", async () => {
    const r = await fetchBenchmarkObservation("us", TODAY, {
      ...sessionMissing, usQuote: async () => ({ price: 705.4, stale: false }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.observation.close).toBe(705.4);
      expect(r.observation.sessionDate).toBe(TODAY);
      // Labelled provisional so the settle pass knows to revisit it.
      expect(r.observation.source).toBe("yahoo_quote(provisional)");
    }
  });

  it("REFUSES to backfill an older session from a quote — the hard guard", async () => {
    // A quote says nothing about any session other than the current one.
    let quoteCalls = 0;
    // dayOffset(5) is absent from the fixture series (which holds 3/2/1) and is
    // not the current session either, so the guard must refuse without asking.
    const r = await fetchBenchmarkObservation("us", dayOffset(5), {
      ...sessionMissing, usQuote: async () => { quoteCalls++; return { price: 705.4, stale: false }; },
    });
    expect(r.ok).toBe(false);
    expect(quoteCalls).toBe(0);   // never even asked
  });

  it("refuses a stale quote rather than dating it to today", async () => {
    const r = await fetchBenchmarkObservation("us", TODAY, {
      ...sessionMissing, usQuote: async () => ({ price: 705.4, stale: true }),
    });
    expect(r.ok).toBe(false);
  });

  it("prefers a real daily BAR whenever one exists — quote is last resort", async () => {
    let quoteCalls = 0;
    const r = await fetchBenchmarkObservation("us", TODAY, {
      us: async () => ({ candles: [bar(TODAY, 710.27)], source: "yahoo" }),
      usFallback: async () => [],
      india: async () => [],
      indiaCrossCheck: async () => [],
      usQuote: async () => { quoteCalls++; return { price: 999, stale: false }; },
    });
    expect(quoteCalls).toBe(0);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.observation.close).toBe(710.27); expect(r.observation.source).toBe("yahoo"); }
  });

  it("does NOT rescue a total provider outage — only a missing session", async () => {
    // With no bars at all we cannot tell the series is sane, so a lone quote is
    // refused. The fallback narrows a WORKING provider to one missing session;
    // it is not a substitute for having no data.
    let quoteCalls = 0;
    const r = await fetchBenchmarkObservation("us", TODAY, {
      us: async () => ({ candles: [] as any, source: "yahoo" }),
      usFallback: async () => [] as any,
      india: async () => [] as any,
      indiaCrossCheck: async () => [] as any,
      usQuote: async () => { quoteCalls++; return { price: 705.4, stale: false }; },
    });
    expect(r.ok).toBe(false);
    expect(quoteCalls).toBe(0);
    if (!r.ok) expect(r.reason).toBe("benchmark_bars_unavailable");
  });

  it("a quote-source outage cannot break the path", async () => {
    const r = await fetchBenchmarkObservation("us", TODAY, {
      ...sessionMissing, usQuote: async () => { throw new Error("yahoo 500"); },
    });
    expect(r.ok).toBe(false);   // refuses cleanly, does not throw
  });
});
