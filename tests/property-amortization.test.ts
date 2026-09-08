import { describe, expect, it } from "vitest";
import { monthsElapsed, summarizeAmortization } from "@/lib/property/amortization";

describe("monthsElapsed", () => {
  it("counts whole calendar months, floored", () => {
    expect(monthsElapsed("2020-01-15", "2020-01-20")).toBe(0);
    expect(monthsElapsed("2020-01-15", "2020-02-10")).toBe(0);
    expect(monthsElapsed("2020-01-15", "2020-02-15")).toBe(1);
    expect(monthsElapsed("2020-01-15", "2025-01-15")).toBe(60);
  });

  it("never goes negative", () => {
    expect(monthsElapsed("2025-01-01", "2020-01-01")).toBe(0);
  });
});

describe("summarizeAmortization", () => {
  it("matches a hand-computed 5-year point on a 30yr/6%/$300k loan", () => {
    // Hand-computed via the standard fixed-payment formula:
    // payment = 300000 * (0.005) / (1 - 1.005^-360) = 1798.65...
    const summary = summarizeAmortization({
      originalPrincipal: 300_000,
      annualRatePct: 6,
      originalTermMonths: 360,
      startDate: "2020-01-01",
      asOfDate: "2025-01-01",
    });
    expect(summary.elapsedMonths).toBe(60);
    expect(summary.remainingMonths).toBe(300);
    // Known closed-form remaining balance after k of n payments:
    // B = P*(1+r)^k - payment * ((1+r)^k - 1) / r . For P=300000, r=0.005, n=360, k=60:
    expect(summary.currentBalance).toBeCloseTo(279_163.07, 0);
    expect(summary.paidToDate.principal).toBeCloseTo(300_000 - summary.currentBalance, 6);
    expect(summary.paidToDate.payments).toBeCloseTo(summary.paidToDate.principal + summary.paidToDate.interest, 6);
    expect(summary.remaining.principal).toBeCloseTo(summary.currentBalance, 6);
  });

  it("zero-rate loan splits principal evenly with zero interest either side", () => {
    const summary = summarizeAmortization({
      originalPrincipal: 120_000,
      annualRatePct: 0,
      originalTermMonths: 120,
      startDate: "2020-01-01",
      asOfDate: "2023-01-01", // 36 months elapsed
    });
    expect(summary.elapsedMonths).toBe(36);
    expect(summary.paidToDate.interest).toBe(0);
    expect(summary.remaining.interest).toBe(0);
    expect(summary.paidToDate.principal).toBeCloseTo(36_000, 6);
    expect(summary.currentBalance).toBeCloseTo(84_000, 6);
  });

  it("a term shorter than elapsed time is treated as paid off, not extrapolated", () => {
    const summary = summarizeAmortization({
      originalPrincipal: 50_000,
      annualRatePct: 5,
      originalTermMonths: 24,
      startDate: "2015-01-01",
      asOfDate: "2025-01-01", // 120 months elapsed, term was only 24
    });
    expect(summary.elapsedMonths).toBe(24);
    expect(summary.remainingMonths).toBe(0);
    expect(summary.currentBalance).toBe(0);
    expect(summary.remaining.principal).toBe(0);
    expect(summary.remaining.interest).toBe(0);
    expect(summary.paidToDate.principal).toBeCloseTo(50_000, 6);
  });
});
