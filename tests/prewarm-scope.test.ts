import { describe, expect, it } from "vitest";
import { resolvePrewarmScope, PREWARM_RECENT_DECISION_DAYS } from "@/lib/data/prewarm-scope";
import { evaluateFreshness, FRESHNESS_CONTRACTS, type WatermarkRow } from "@/lib/monitoring/freshness-contracts";
import { expectedNewestSession } from "@/lib/data/completed-candles";

// THE DEFECT. The freshness MONITOR required every US symbol scored in the last
// 7 days plus every open position to hold a current bar
// (`active_us_price_symbols`). The REFRESHER prewarmed only today's batch plus
// the benchmark ETFs. A symbol scored five days ago and absent from today's
// batch was required fresh and refreshed by nothing.
//
// Not a monitoring nit: a stale non-held symbol is still scored, still becomes
// entry-eligible, and is then refused at fill time. Measured 2026-09-01,
// quote_stale=7 blocked 7 of 10 eligible US candidates; the monitor reported
// 17/113 scopes past grace at 85% coverage against a 90% floor.

describe("prewarm scope covers what the freshness contract demands", () => {
  it("includes open positions and recently scored symbols, not just the batch", () => {
    const scope = resolvePrewarmScope({
      batch: ["AAPL", "MSFT"],
      benchmarks: ["VOO"],
      openPositions: ["NVDA"],
      recentlyScored: ["LLY", "MRK"],
    });
    // The two that the old `batch + benchmarks` scope silently dropped.
    expect(scope).toContain("LLY");
    expect(scope).toContain("MRK");
    expect(scope).toContain("NVDA");
  });

  it("looks back exactly as far as the contract calls a symbol active", () => {
    // If the refresher's window is shorter than the monitor's, the gap reopens
    // silently for symbols in between.
    expect(PREWARM_RECENT_DECISION_DAYS).toBe(7);
  });

  it("orders by money consequence: positions, then candidates, then benchmarks, then tail", () => {
    // prewarmPriceCache is deadline-bounded and consumes its input IN ORDER, so
    // whatever gets cut must be the least costly to leave stale. A stale open
    // position misprices a stop; a stale recent-decision name cannot fill today.
    const scope = resolvePrewarmScope({
      batch: ["BATCH1"],
      benchmarks: ["BENCH1"],
      openPositions: ["POS1"],
      recentlyScored: ["TAIL1"],
    });
    expect(scope).toEqual(["POS1", "BATCH1", "BENCH1", "TAIL1"]);
  });

  it("de-duplicates and upper-cases without losing priority", () => {
    // A held name also in today's batch must keep its POSITION priority.
    const scope = resolvePrewarmScope({
      batch: ["nvda", "AAPL"],
      benchmarks: ["VOO"],
      openPositions: ["NVDA"],
      recentlyScored: ["aapl", "VOO"],
    });
    expect(scope).toEqual(["NVDA", "AAPL", "VOO"]);
  });

  it("drops empty and whitespace symbols rather than fetching them", () => {
    expect(resolvePrewarmScope({
      batch: ["", "   ", "AAPL"], benchmarks: [], openPositions: [], recentlyScored: [],
    })).toEqual(["AAPL"]);
  });
});

describe("the price-cache contract measures sessions, not calendar hours", () => {
  const contract = FRESHNESS_CONTRACTS.find((c) => c.id === "price-cache-us-symbols")!;

  it("is marked session-aware", () => {
    expect(contract.sessionAware).toBe(true);
    expect(contract.watermarkType).toBe("date");
  });

  it("calls Friday's bar STALE on Tuesday morning, where a 96h grace called it fresh", () => {
    // Tuesday 12:00Z (08:00 ET, pre-open). The 96h window reaches back to
    // 2026-08-28T12:00Z, and Friday's bar timestamps at 20:00Z — INSIDE the
    // window, so the calendar rule passes a book stuck on Friday. The session
    // rule asks the only question that matters — Monday 08-31 should exist by
    // now — and fails it.
    //
    // The separating time matters: by 21:00Z the same Friday bar is stale under
    // BOTH rules, because this contract compares timestamps while the prewarm
    // compared date strings. Same "96", different granularity. An earlier draft
    // of this test asserted at 21:00Z and proved nothing.
    const tuesdayMorning = new Date("2026-09-01T12:00:00Z");
    const rows: WatermarkRow[] = [{ scope: "AAPL", watermark: "2026-08-28" }];
    expect(expectedNewestSession("us", tuesdayMorning)).toBe("2026-08-31");

    const sessionResult = evaluateFreshness(contract, rows, tuesdayMorning);
    expect(sessionResult.staleScopes).toEqual(["AAPL"]);

    // Same rows under the OLD calendar rule: not stale. This is what was hidden.
    const calendarResult = evaluateFreshness(
      { ...contract, sessionAware: false }, rows, tuesdayMorning,
    );
    expect(calendarResult.staleScopes).toEqual([]);
  });

  it("does not call the current session stale", () => {
    const tuesday = new Date("2026-09-01T21:00:00Z");
    const current = expectedNewestSession("us", tuesday);
    const result = evaluateFreshness(contract, [{ scope: "AAPL", watermark: current }], tuesday);
    expect(result.staleScopes).toEqual([]);
    expect(result.breached).toBe(false);
  });

  it("leaves timestamp contracts on the calendar grace", () => {
    // Label maturation is a timestamp watermark with no market session; the
    // rolling window is the right shape there and must not change.
    const labels = FRESHNESS_CONTRACTS.find((c) => c.id === "observation-labels-maturation")!;
    expect(labels.sessionAware).toBeUndefined();
    expect(labels.watermarkType).toBe("timestamp");
  });
});
