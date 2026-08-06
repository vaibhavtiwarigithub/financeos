import { describe, it, expect } from "vitest";
import {
  cohortValue,
  computeEventOutcome,
  entryIndex,
  marketCloseHour,
  MIN_INSTANCES,
  summarizeBaseRate,
  type OhlcBar,
} from "@/lib/events/outcomes";

// A flat-then-rising series with a distinct low, so MAE/MFE are checkable.
const BARS: OhlcBar[] = [
  { date: "2025-04-07", high: 101, low: 96, close: 100 },
  { date: "2025-04-08", high: 102, low: 94, close: 98 },
  { date: "2025-04-09", high: 103, low: 90, close: 100 },
  { date: "2025-04-10", high: 112, low: 99, close: 110 },
  { date: "2025-04-11", high: 118, low: 108, close: 115 },
  { date: "2025-04-14", high: 125, low: 114, close: 121 },
];

describe("entryIndex — the anti-look-ahead anchor", () => {
  it("an INTRADAY US event is tradable at that day's close", () => {
    // 2025-04-09T17:20Z is 13:20 ET, before the 20:00Z US close. The reaction
    // to it is still in that session's close, so measuring from 04-09 is
    // legitimate — this is the canonical instance in the ledger.
    expect(entryIndex(BARS, "2025-04-09T17:20:00.000Z", "us")).toBe(2);
  });

  it("the SAME timestamp is NOT tradable in India until the next session", () => {
    // India closes at 10:00Z, three hours before the announcement. Entering on
    // 04-09 would book a return that begins before the news was public.
    expect(entryIndex(BARS, "2025-04-09T17:20:00.000Z", "india")).toBe(3);
  });

  it("a date-precision row stamped 23:59Z always lands on the NEXT session", () => {
    // This is why the backfill stamps end-of-day rather than midnight: 00:00Z
    // would place the event a day early and fold the reaction into the
    // 'forward' return.
    expect(entryIndex(BARS, "2025-04-09T23:59:00.000Z", "us")).toBe(3);
  });

  it("00:00Z on the event date would have started a session EARLY", () => {
    // Kept as a regression pin: this is the bug the 23:59Z convention avoids.
    expect(entryIndex(BARS, "2025-04-09T00:00:00.000Z", "us")).toBe(2);
    expect(entryIndex(BARS, "2025-04-09T23:59:00.000Z", "us")).toBeGreaterThan(
      entryIndex(BARS, "2025-04-09T00:00:00.000Z", "us"),
    );
  });

  it("returns -1 when no session follows the event, and on a bad timestamp", () => {
    expect(entryIndex(BARS, "2026-01-01T00:00:00.000Z", "us")).toBe(-1);
    expect(entryIndex(BARS, "not-a-date", "us")).toBe(-1);
  });

  it("an unknown market falls back to the later (US) close, the conservative side", () => {
    expect(marketCloseHour("mars")).toBe(marketCloseHour("us"));
  });
});

describe("computeEventOutcome", () => {
  it("measures from the entry close to the exit close", () => {
    const out = computeEventOutcome(BARS, [], "2025-04-09T17:20:00.000Z", "us", 1)!;
    expect(out.entryDate).toBe("2025-04-09");
    expect(out.exitDate).toBe("2025-04-10");
    expect(out.fwdReturn).toBeCloseTo(0.10);
    expect(out.sessionsUsed).toBe(1);
  });

  it("returns null — never 0 — when the horizon has not fully elapsed", () => {
    // An unmatured horizon must stay ABSENT so the base rate's n stays honest.
    // Reporting it as a zero return would silently pull every mean toward zero.
    expect(computeEventOutcome(BARS, [], "2025-04-09T17:20:00.000Z", "us", 21)).toBeNull();
  });

  it("aligns the benchmark by DATE, not by index", () => {
    // The benchmark here is missing 04-10, i.e. a different holiday calendar.
    // Joining on position would silently compare two different days.
    const bench: OhlcBar[] = [
      { date: "2025-04-09", high: 50, low: 49, close: 50 },
      { date: "2025-04-11", high: 53, low: 51, close: 52 },
    ];
    const out = computeEventOutcome(BARS, bench, "2025-04-09T17:20:00.000Z", "us", 1)!;
    expect(out.benchmarkReturn).toBeNull();
    expect(out.benchmarkNeutralReturn).toBeNull();
    expect(out.fwdReturn).toBeCloseTo(0.10); // the subject leg still stands
  });

  it("computes benchmark-neutral return when both legs align", () => {
    const bench: OhlcBar[] = [
      { date: "2025-04-09", high: 50, low: 49, close: 50 },
      { date: "2025-04-10", high: 53, low: 51, close: 52 },
    ];
    const out = computeEventOutcome(BARS, bench, "2025-04-09T17:20:00.000Z", "us", 1)!;
    expect(out.benchmarkReturn).toBeCloseTo(0.04);
    expect(out.benchmarkNeutralReturn).toBeCloseTo(0.06);
  });

  it("MAE and MFE span the whole window, not just the endpoints", () => {
    const out = computeEventOutcome(BARS, [], "2025-04-09T17:20:00.000Z", "us", 2)!;
    expect(out.maxAdverseExcursion).toBeCloseTo(-0.01); // low 99 on 04-10
    expect(out.maxFavorableExcursion).toBeCloseTo(0.18); // high 118 on 04-11
  });

  it("rejects a non-positive horizon", () => {
    expect(computeEventOutcome(BARS, [], "2025-04-09T17:20:00.000Z", "us", 0)).toBeNull();
  });
});

describe("cohortValue — market-wide events must not summarise to zero", () => {
  it("uses the RAW return for a market-wide event, where neutral is 0 by construction", () => {
    // Verified against the live ledger: every tariff outcome stored
    // benchmark_neutral_return = 0.0000 because the subject IS the benchmark.
    // Preferring the neutral leg would have reported every tariff base rate as
    // exactly zero — which reads as a finding and is an artefact.
    expect(cohortValue({
      subject_symbol: "SPY", benchmark_symbol: "SPY",
      fwd_return: -0.0419, benchmark_neutral_return: 0,
    })).toBeCloseTo(-0.0419);
  });

  it("uses the benchmark-neutral return for an idiosyncratic event", () => {
    expect(cohortValue({
      subject_symbol: "AAPL", benchmark_symbol: "SPY",
      fwd_return: 0.05, benchmark_neutral_return: 0.03,
    })).toBeCloseTo(0.03);
  });

  it("excludes an idiosyncratic event when no benchmark aligned", () => {
    expect(cohortValue({
      subject_symbol: "AAPL", benchmark_symbol: "SPY",
      fwd_return: 0.05, benchmark_neutral_return: null,
    })).toBeNull();
  });

  it("returns null, not 0, when nothing is measurable", () => {
    expect(cohortValue({
      subject_symbol: "AAPL", benchmark_symbol: "SPY",
      fwd_return: null, benchmark_neutral_return: null,
    })).toBeNull();
  });
});

describe("summarizeBaseRate — the floor refuses, it does not caveat", () => {
  it("reports nulls below the floor while still reporting n", () => {
    const s = summarizeBaseRate("policy_tariff_reversed", "us", 5, [0.01, 0.02, 0.03]);
    expect(s.n).toBe(3);
    expect(s.sufficient).toBe(false);
    expect(s.meanReturn).toBeNull();
    expect(s.medianReturn).toBeNull();
    expect(s.hitRate).toBeNull();
  });

  it("computes only at or above the floor", () => {
    const returns = Array.from({ length: MIN_INSTANCES }, (_, i) => (i < 15 ? 0.02 : -0.01));
    const s = summarizeBaseRate("policy_tariff_reversed", "us", 5, returns);
    expect(s.sufficient).toBe(true);
    expect(s.n).toBe(MIN_INSTANCES);
    expect(s.hitRate).toBeCloseTo(0.75);
    expect(s.meanReturn).toBeCloseTo((15 * 0.02 + 5 * -0.01) / MIN_INSTANCES);
    expect(s.stdDev).toBeGreaterThan(0);
  });

  it("one instance short of the floor still refuses", () => {
    const returns = Array.from({ length: MIN_INSTANCES - 1 }, () => 0.05);
    expect(summarizeBaseRate("guidance_cut", "us", 21, returns).meanReturn).toBeNull();
  });

  it("drops non-finite values from n rather than propagating NaN", () => {
    const s = summarizeBaseRate("guidance_cut", "india", 1, [0.01, NaN, Infinity, 0.02]);
    expect(s.n).toBe(2);
  });
});
