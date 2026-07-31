import { describe, it, expect, vi } from "vitest";
import { computeScores, MAX_MACRO_AGE_DAYS } from "@/lib/data/scores";
import { computeWeightedAnalystScore } from "@/lib/scoring/weighted-score";

// MONEY-PATH TESTS. macro_score is one of the 5 genome dimensions: it feeds the
// weighted analyst score → the direction gate → paper buys.
//
// Two proven prod bugs are pinned here:
//  BUG 1 — macro_regime has NO `market` column, so lib/data/scores.ts read it
//          unfiltered and scored India stocks with the US FRED regime.
//  BUG 2 — the stale-regime selector skipped "unknown" rows with NO age bound,
//          reaching back to a 2026-06-30 `green` row on 2026-07-13 (13 days).

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** The exact prod macro_regime table as of 2026-07-16. */
const PROD_ROWS = [
  { week_of: "2026-07-13", regime: "orange", danger_score: 40, signals_triggered: 6, raw_indicators: new Array(7).fill({ signal: "yellow" }) },
  { week_of: "2026-07-06", regime: "unknown", danger_score: 0, signals_triggered: 0, raw_indicators: [] },
  { week_of: "2026-06-30", regime: "green", danger_score: 0, signals_triggered: 0, raw_indicators: [] },
];

function supabaseWith(rows: any[]) {
  const b: any = {
    select: () => b,
    order: () => b,
    limit: () => Promise.resolve({ data: rows, error: null }),
    insert: () => Promise.resolve({ data: null, error: null }),
    upsert: () => Promise.resolve({ data: null, error: null }),
  };
  return { from: vi.fn((_table: string) => b) };
}

/** 60 candles of gently rising price → technical dimension is genuinely available. */
const CANDLES = Array.from({ length: 60 }, (_, i) => ({
  date: `2026-05-${String((i % 28) + 1).padStart(2, "0")}`,
  close: 100 + i, high: 101 + i, low: 99 + i, open: 100 + i, volume: 1_000_000,
}));

/** A real overview with >=2 fundamental fields → fundamental dimension available. */
const OVERVIEW = {
  Symbol: "TEST", Sector: "Technology",
  PERatio: "18", ProfitMargin: "0.25", ReturnOnEquityTTM: "0.22", EPS: "5",
};

function run(opts: { symbol: string; rows: any[]; now: Date }) {
  return computeScores({
    symbol: opts.symbol,
    isEtf: false,
    avOverview: OVERVIEW as any,
    candles: CANDLES,
    socialResult: { has_data: false },   // sentiment unavailable (matches India prod)
    insiderResult: null,                 // insider unavailable (matches India prod)
    supabase: supabaseWith(opts.rows),
    now: opts.now,
  });
}

const NOW_0713 = new Date("2026-07-13T18:00:00Z");
const NOW_0716 = new Date("2026-07-16T18:00:00Z");

// India's live champion weights (strategy_versions id=4, market=india).
const W = { fundamental: 0.30, technical: 0.25, sentiment: 0.20, macro: 0.15, insider: 0.10 };

// ── BUG 1: India must never be scored with the US macro regime ────────────────

describe("BUG 1 — India macro is honestly UNAVAILABLE, never the US regime", () => {
  it("market=india → macroDataAvailable false even with a FRESH US regime row", async () => {
    const r = await run({ symbol: "RELIANCE.NS", rows: PROD_ROWS, now: NOW_0713 });
    // FAILS on current code: the 07-13 orange row is fresh + known, so India
    // inherited danger_score 40 → macro_score 60 → counted as real evidence.
    expect(r.dataQuality.macroDataAvailable).toBe(false);
    expect(r.evidence.macro).toMatchObject({ market: "india", source: "none" });
  });

  it("market is derived from the symbol — a .NS/.BO caller cannot forget it", async () => {
    for (const sym of ["INFY.NS", "SBIN.NS", "RELIANCE.BO"]) {
      const r = await run({ symbol: sym, rows: PROD_ROWS, now: NOW_0713 });
      expect(r.dataQuality.macroDataAvailable).toBe(false);
    }
  });

  it("India does NOT hit the macro_regime table at all", async () => {
    const sb = supabaseWith(PROD_ROWS);
    await computeScores({
      symbol: "TCS.NS", isEtf: false, avOverview: OVERVIEW as any, candles: CANDLES,
      socialResult: { has_data: false }, insiderResult: null, supabase: sb, now: NOW_0713,
    });
    expect(sb.from.mock.calls.map(c => c[0])).not.toContain("macro_regime");
  });

  it("excluding macro RENORMALIZES the weights over the remaining dims (asserts the score)", async () => {
    const r = await run({ symbol: "NAUKRI.NS", rows: PROD_ROWS, now: NOW_0716 });

    const included = {
      fundamental: r.dataQuality.fundamentalDataAvailable,
      technical: r.dataQuality.technicalDataPoints >= 15,
      sentiment: r.dataQuality.sentimentDataAvailable,
      macro: r.dataQuality.macroDataAvailable,
      insider: r.dataQuality.insiderDataAvailable,
    };
    // India in prod scores on exactly {fundamental, technical} once macro is out.
    expect(included).toEqual({ fundamental: true, technical: true, sentiment: false, macro: false, insider: false });

    const scores = {
      fundamental: r.fundamental_score, technical: r.technical_score,
      sentiment: r.sentiment_score, macro: r.macro_score, insider: r.insider_score,
    };
    const out = computeWeightedAnalystScore(scores, included, W);

    // Macro carries ZERO weight and the surviving weights are rescaled to 1.0.
    expect(out.effWeights.macro).toBe(0);
    expect(out.renormalized).toBe(true);
    expect(out.effWeights.fundamental).toBeCloseTo(0.30 / 0.55, 6);
    expect(out.effWeights.technical).toBeCloseTo(0.25 / 0.55, 6);
    expect(out.effWeights.fundamental + out.effWeights.technical).toBeCloseTo(1.0, 6);

    // The renormalized score itself — not merely the flag.
    const expected = Math.round(r.fundamental_score * (0.30 / 0.55) + r.technical_score * (0.25 / 0.55));
    expect(out.score).toBe(expected);

    // 2 usable dims is NOT thin evidence → the gate still transacts. Removing
    // macro must not silently mute India via the abstain path.
    expect(out.abstain).toBe(false);
    expect(out.includedDims).toEqual(["fundamental", "technical"]);
  });
});

// ── BUG 1 guard: US scoring must be COMPLETELY unchanged ─────────────────────

describe("market=us with a fresh regime — behavior must NOT change", () => {
  it("US picks up the fresh 07-13 orange row: danger 40 → macro_score 60, available", async () => {
    const r = await run({ symbol: "AAPL", rows: PROD_ROWS, now: NOW_0713 });
    expect(r.dataQuality.macroDataAvailable).toBe(true);
    expect(r.macro_score).toBe(60); // 100 - danger_score(40)
    expect(r.evidence.macro).toMatchObject({ regime: "orange", danger_score: 40, as_of: "2026-07-13", market: "us" });
  });

  it("US macro stays available across the whole bound (07-13 row still fresh on 07-16)", async () => {
    const r = await run({ symbol: "MSFT", rows: PROD_ROWS, now: NOW_0716 });
    expect(r.dataQuality.macroDataAvailable).toBe(true);
    expect(r.macro_score).toBe(60);
  });

  it("a fresh 'green' row backed by real indicators is still a valid calm verdict", async () => {
    const rows = [{ week_of: "2026-07-13", regime: "green", danger_score: 0, signals_triggered: 0, raw_indicators: new Array(8).fill({ signal: "green" }) }];
    const r = await run({ symbol: "AAPL", rows, now: NOW_0713 });
    // signals_triggered === 0 is NOT itself suspect: a calm week really does
    // trip zero signals. 8 real indicators back this verdict.
    expect(r.dataQuality.macroDataAvailable).toBe(true);
    expect(r.macro_score).toBe(100);
  });
});

// ── BUG 2: the age bound ─────────────────────────────────────────────────────

describe("BUG 2 — stale-regime selection is age-bounded and fails SAFE", () => {
  it("the EXACT prod scenario: [07-13 orange, 07-06 unknown, 06-30 green] must NOT select 06-30", async () => {
    const r = await run({ symbol: "AAPL", rows: PROD_ROWS, now: NOW_0713 });
    // The fortnight-stale green must never win.
    expect(r.macro_score).not.toBe(100);
    expect(r.evidence.macro).toMatchObject({ as_of: "2026-07-13", regime: "orange" });
  });

  it("a stale non-unknown row BEYOND the bound → UNAVAILABLE, not a calm/green default", async () => {
    // Only the fossil green remains in range of the reach-back.
    const rows = [
      { week_of: "2026-07-06", regime: "unknown", danger_score: 0, signals_triggered: 0, raw_indicators: [] },
      { week_of: "2026-06-30", regime: "green", danger_score: 0, signals_triggered: 0, raw_indicators: new Array(8).fill({ signal: "green" }) },
    ];
    const r = await run({ symbol: "AAPL", rows, now: NOW_0713 }); // 06-30 is 13d old > 10d
    // FAILS on current code: it selects the 06-30 green → macro_score 100.
    expect(r.dataQuality.macroDataAvailable).toBe(false);
    expect(r.macro_score).not.toBe(100);
    expect(String((r.evidence.macro as any).note)).toMatch(/UNAVAILABLE/i);
  });

  it("a stale RED row is equally rejected — the bound is not direction-biased", async () => {
    const rows = [{ week_of: "2026-06-01", regime: "red", danger_score: 100, signals_triggered: 5, raw_indicators: new Array(8).fill({ signal: "red" }) }];
    const r = await run({ symbol: "AAPL", rows, now: NOW_0713 });
    expect(r.dataQuality.macroDataAvailable).toBe(false);
  });

  it("a one-week reach-back WITHIN the bound is still allowed (fresh run failed)", async () => {
    const rows = [
      { week_of: "2026-07-13", regime: "unknown", danger_score: 0, signals_triggered: 0, raw_indicators: [] },
      { week_of: "2026-07-06", regime: "orange", danger_score: 40, signals_triggered: 6, raw_indicators: new Array(7).fill({ signal: "yellow" }) },
    ];
    const r = await run({ symbol: "AAPL", rows, now: NOW_0713 }); // 07-06 is 7d old <= 10d
    expect(r.dataQuality.macroDataAvailable).toBe(true);
    expect(r.evidence.macro).toMatchObject({ as_of: "2026-07-06" });
  });

  it("the bound admits a current row on the Monday BEFORE the next cron fires (age 7d)", async () => {
    const rows = [{ week_of: "2026-07-13", regime: "orange", danger_score: 40, signals_triggered: 6, raw_indicators: new Array(7).fill({ signal: "y" }) }];
    // 2026-07-20 09:00Z — cron (Mon 12:30Z) has not run yet; 07-13 is the
    // freshest legitimate verdict at exactly 7 days old.
    const r = await run({ symbol: "AAPL", rows, now: new Date("2026-07-20T09:00:00Z") });
    expect(r.dataQuality.macroDataAvailable).toBe(true);
    expect(MAX_MACRO_AGE_DAYS).toBeGreaterThan(7);
  });

  it("the bound is below 14d — a fully missed weekly run can never be masked", async () => {
    expect(MAX_MACRO_AGE_DAYS).toBeLessThan(14);
  });

  it("empty macro_regime table → unavailable, never calm", async () => {
    const r = await run({ symbol: "AAPL", rows: [], now: NOW_0713 });
    expect(r.dataQuality.macroDataAvailable).toBe(false);
  });
});

// ── Zero-indicator fossils ───────────────────────────────────────────────────

describe("a 'green' verdict with zero indicators is a failed run, not calm markets", () => {
  it("rejects the prod 06-30 fossil (green, danger 0, raw_indicators []) even when FRESH", async () => {
    const rows = [{ week_of: "2026-07-13", regime: "green", danger_score: 0, signals_triggered: 0, raw_indicators: [] }];
    const r = await run({ symbol: "AAPL", rows, now: NOW_0713 });
    // In range of the age bound, so ONLY the indicator-count check can catch it.
    expect(r.dataQuality.macroDataAvailable).toBe(false);
    expect(r.macro_score).not.toBe(100);
  });

  it("rejects the prod 06-29 fossil class (red off a single indicator)", async () => {
    const rows = [{ week_of: "2026-07-13", regime: "red", danger_score: 100, signals_triggered: 1, raw_indicators: [{ signal: "red" }] }];
    const r = await run({ symbol: "AAPL", rows, now: NOW_0713 });
    expect(r.dataQuality.macroDataAvailable).toBe(false);
  });

  it("unverifiable raw_indicators (null) fails CLOSED", async () => {
    const rows = [{ week_of: "2026-07-13", regime: "green", danger_score: 0, signals_triggered: 0, raw_indicators: null }];
    const r = await run({ symbol: "AAPL", rows, now: NOW_0713 });
    expect(r.dataQuality.macroDataAvailable).toBe(false);
  });

  it("a macro query failure is unavailable, never calm", async () => {
    const sb: any = { from: () => ({ select: () => ({ order: () => ({ limit: () => { throw new Error("boom"); } }) }) }) };
    const r = await computeScores({
      symbol: "AAPL", isEtf: false, avOverview: OVERVIEW as any, candles: CANDLES,
      socialResult: { has_data: false }, insiderResult: null, supabase: sb, now: NOW_0713,
    });
    expect(r.dataQuality.macroDataAvailable).toBe(false);
  });
});

describe("macro danger-score data contract", () => {
  it("rejects a known regime whose danger score is missing or invalid", async () => {
    for (const danger_score of [null, Number.NaN, -1, 101]) {
      const rows = [{
        week_of: "2026-07-13", regime: "green", danger_score,
        signals_triggered: 0, raw_indicators: new Array(8).fill({ signal: "green" }),
      }];
      const r = await run({ symbol: "AAPL", rows, now: NOW_0713 });
      expect(r.dataQuality.macroDataAvailable).toBe(false);
      expect(r.macro_score).toBe(50);
    }
  });
});
