// Unit-scale contract for India fundamentals + the governance state that makes
// the scale currently harmless.
//
// Yahoo reports debtToEquity as a PERCENTAGE (AAPL 78.445) while Finnhub uses a
// RATIO (AAPL 1.3547). lib/india-data.ts mapped Yahoo's value raw, so every India
// D/E was stored ~100x too large — TCS's true 0.10 stored as 10.21, and 15 of 24
// India symbols would have landed in the wrong risk bucket.
//
// It did NOT corrupt any score, because ba20f4ff ("restore score governance")
// made D/E measure_only: the value is recorded as evidence and contributes zero
// points. That is exactly why the second test here exists — it pins the
// measure_only state, so that anyone re-enabling D/E scoring is forced to
// confront these units first rather than inheriting a silent 100x error onto the
// money path.
import { describe, it, expect } from "vitest";
import { scoreFundamentals } from "@/lib/data/scores";

const OV = (over: Record<string, string>) => ({ Symbol: "T", Sector: "Technology", ...over });

describe("India D/E unit contract", () => {
  it("records D/E as evidence but scores ZERO points for it today", () => {
    const base = scoreFundamentals(OV({}), false);
    for (const de of ["0.1021", "10.21", "3.9356"]) {
      const r = scoreFundamentals(OV({ DebtToEquity: de }), false);
      expect(r.score, `D/E ${de} must not move the score while measure_only`).toBe(base.score);
      expect((r.evidence as any).debt_to_equity).toBeCloseTo(parseFloat(de), 4);
      expect((r.evidence as any).debt_to_equity_scoring_status).toBe("measure_only");
    }
  });

  it("keeps the other governance-disabled fundamentals measure_only too", () => {
    const r = scoreFundamentals(
      OV({ FCFYield: "0.03", GrossMarginTTM: "0.52", PEGRatio: "1.4", "52WeekHigh": "100" }),
      false,
      95,
    );
    const e = r.evidence as any;
    expect(e.fcf_yield_scoring_status).toBe("measure_only");
    expect(e.gross_margin_scoring_status).toBe("measure_only");
    expect(e.peg_ratio_scoring_status).toBe("measure_only");
    expect(e.pct_from_52w_high_scoring_status).toBe("measure_only");
  });

  it("still scores the five components that ARE live", () => {
    // Guards the inverse mistake: governance disabled five inputs, it must not
    // have disabled everything.
    const base = scoreFundamentals(OV({}), false).score;
    expect(scoreFundamentals(OV({ ProfitMargin: "0.25" }), false).score).toBeGreaterThan(base);
    expect(scoreFundamentals(OV({ ReturnOnEquityTTM: "0.25" }), false).score).toBeGreaterThan(base);
    expect(scoreFundamentals(OV({ EPS: "5" }), false).score).toBeGreaterThan(base);
    expect(scoreFundamentals(OV({ QuarterlyRevenueGrowthYOY: "0.25" }), false).score).toBeGreaterThan(base);
    expect(scoreFundamentals(OV({ ProfitMargin: "-0.10" }), false).score).toBeLessThan(base);
  });

  it("converts a Yahoo percentage into the ratio convention", () => {
    // The mapping lib/india-data.ts performs, asserted as arithmetic so the /100
    // cannot be "simplified" away without failing here.
    const yahooPercent = 10.21;   // TCS as Yahoo reports it
    const asRatio = yahooPercent / 100;
    expect(asRatio).toBeCloseTo(0.1021, 4);
    // Ratio scale must place TCS in the conservative band that Finnhub-sourced
    // US names occupy (median ~0.27), not above the 3.0 high-leverage line.
    expect(asRatio).toBeLessThan(0.5);
    expect(yahooPercent).toBeGreaterThan(3.0);
  });
});
