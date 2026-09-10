import { describe, expect, it } from "vitest";
import { deepSeekPeakMultiplier } from "@/lib/llm-router";

// THE DEFECT THIS GUARDS.
//
// PRICING carried [0.14, 0.28] for deepseek-v4-flash and [0.435, 0.87] for
// deepseek-v4-pro. DeepSeek's published off-peak cache-miss rates are
// [0.22, 0.66] and [0.66, 1.98], with peak at exactly 2x. Output — the dominant
// cost for a thinking model, whose chain-of-thought bills as completion tokens —
// was understated by 2.4x to 4.7x.
//
// Measured 2026-09-09 over 30 days of llm_call_log: the ledger totalled $1.47
// while the DeepSeek dashboard billed $5.65. The tokens were logged correctly
// the whole time; only the constants were wrong.
//
// DeepSeek's peak window is the second half of the fix. Off-peak is the base
// rate in PRICING, so getting the window wrong silently doubles or halves every
// cost figure in the ledger.

const utc = (day: number, hour: number) =>
  // 2026-09-07 is a Monday, so +day lands on the intended weekday.
  new Date(Date.UTC(2026, 8, 7 + day, hour, 30, 0));

const MON = 0, TUE = 1, FRI = 4, SAT = 5, SUN = 6;

describe("deepSeekPeakMultiplier — weekday peak windows", () => {
  it("01:00-04:00 UTC is peak", () => {
    expect(deepSeekPeakMultiplier(utc(MON, 1))).toBe(2);
    expect(deepSeekPeakMultiplier(utc(MON, 3))).toBe(2);
  });

  it("06:00-10:00 UTC is peak", () => {
    expect(deepSeekPeakMultiplier(utc(TUE, 6))).toBe(2);
    expect(deepSeekPeakMultiplier(utc(TUE, 9))).toBe(2);
  });

  it("the gap between the two windows is off-peak", () => {
    // 04:00-06:00 is NOT peak — an easy window to lose by merging the two ranges.
    expect(deepSeekPeakMultiplier(utc(TUE, 4))).toBe(1);
    expect(deepSeekPeakMultiplier(utc(TUE, 5))).toBe(1);
  });

  it("boundaries are half-open: start is peak, end is not", () => {
    expect(deepSeekPeakMultiplier(new Date(Date.UTC(2026, 8, 7, 1, 0, 0)))).toBe(2);
    expect(deepSeekPeakMultiplier(new Date(Date.UTC(2026, 8, 7, 4, 0, 0)))).toBe(1);
    expect(deepSeekPeakMultiplier(new Date(Date.UTC(2026, 8, 7, 6, 0, 0)))).toBe(2);
    expect(deepSeekPeakMultiplier(new Date(Date.UTC(2026, 8, 7, 10, 0, 0)))).toBe(1);
  });

  it("hours outside both windows are off-peak", () => {
    expect(deepSeekPeakMultiplier(utc(MON, 0))).toBe(1);
    expect(deepSeekPeakMultiplier(utc(MON, 12))).toBe(1);
    expect(deepSeekPeakMultiplier(utc(FRI, 23))).toBe(1);
  });
});

describe("deepSeekPeakMultiplier — weekends are never peak", () => {
  it("Saturday is off-peak even inside a weekday peak hour", () => {
    expect(deepSeekPeakMultiplier(utc(SAT, 2))).toBe(1);
    expect(deepSeekPeakMultiplier(utc(SAT, 7))).toBe(1);
  });

  it("Sunday is off-peak even inside a weekday peak hour", () => {
    expect(deepSeekPeakMultiplier(utc(SUN, 2))).toBe(1);
    expect(deepSeekPeakMultiplier(utc(SUN, 7))).toBe(1);
  });
});

describe("the corrected rates bracket the real bill", () => {
  // The exact tokens llm_call_log recorded over the 30 days to 2026-09-09.
  const LOGGED = {
    pro:   { tin: 931_010, tout: 1_113_789 },
    flash: { tin: 501_105, tout:   106_867 },
  };
  const OFF_PEAK = { pro: [0.66, 1.98], flash: [0.22, 0.66] } as const;

  const bill = (mult: 1 | 2) =>
    (["pro", "flash"] as const).reduce((sum, k) => {
      const [i, o] = OFF_PEAK[k];
      return sum + (LOGGED[k].tin / 1e6) * i * mult + (LOGGED[k].tout / 1e6) * o * mult;
    }, 0);

  it("all-off-peak is the floor and all-peak the ceiling around the $5.65 billed", () => {
    expect(bill(1)).toBeCloseTo(3.0, 1);
    expect(bill(2)).toBeCloseTo(6.0, 1);
    expect(5.65).toBeGreaterThan(bill(1));
    expect(5.65).toBeLessThan(bill(2));
  });

  it("the OLD constants could not reach the real bill at any hour", () => {
    const oldRates = { pro: [0.435, 0.87], flash: [0.14, 0.28] } as const;
    const worstCase = (["pro", "flash"] as const).reduce((sum, k) => {
      const [i, o] = oldRates[k];
      return sum + (LOGGED[k].tin / 1e6) * i + (LOGGED[k].tout / 1e6) * o;
    }, 0);
    // Even before any peak surcharge existed, the old table maxed out near
    // $1.47 — under a third of what DeepSeek actually billed.
    expect(worstCase).toBeLessThan(2.0);
  });
});
