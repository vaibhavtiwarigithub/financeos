import { describe, expect, it } from "vitest";
import { leveragedPaperEntrySize, LEVERAGED_PAPER_MIN_ENTRY_NAV_FRACTION } from "@/lib/trading/leveraged-sleeve-risk";
import { fmtMoney, fmtMoneyAbbrev } from "@/lib/format-money";
import { planSoxlEntry } from "@/lib/trading/soxl-lifecycle";
import { planTqqqEntry } from "@/lib/trading/tqqq-lifecycle";
import { planSqqqEntry } from "@/lib/trading/sqqq-lifecycle";
import { planSoxsEntry } from "@/lib/trading/soxs-lifecycle";

describe("meaningful leveraged paper entry size", () => {
  it("refuses the reproduced sub-cent entry rather than spending cash dust", () => {
    expect(leveragedPaperEntrySize(10000, 0.0005)).toEqual({ ok: false, reason: "below_minimum_entry" });
  });
  it("preserves the exact 0.5%-NAV boundary without growing an order", () => {
    expect(LEVERAGED_PAPER_MIN_ENTRY_NAV_FRACTION).toBe(0.005);
    expect(leveragedPaperEntrySize(10000, 49.99).ok).toBe(false);
    expect(leveragedPaperEntrySize(10000, 50)).toEqual({ ok: true, maxNotional: 50 });
    expect(leveragedPaperEntrySize(10000, 500)).toEqual({ ok: true, maxNotional: 500 });
  });
  it("fails closed on nonfinite capacity and NAV", () => {
    expect(leveragedPaperEntrySize(10000, NaN).ok).toBe(false);
    expect(leveragedPaperEntrySize(NaN, 50).ok).toBe(false);
    expect(leveragedPaperEntrySize(10000, 0)).toMatchObject({ ok: false, reason: "no_capacity" });
  });

  it.each([planSoxlEntry, planTqqqEntry, planSqqqEntry, planSoxsEntry])("all four planners reject cash dust", (plan) => {
    expect(plan({
      policy: { version: "test", maxQuoteAgeMs: 60000, maxSpreadBps: 50, maxMonitorAgeMs: 60000,
        atrStopMultiple: 2, maxStopPct: 12, targetAtrMultiple: 3, riskBudgetPct: 1, semiconductorCapPct: 25 },
      now: 100000, quote: { bid: 100, ask: 100.02, observedAt: 99000 }, signalAt: 90000,
      lastExitAt: null, signalSession: "2026-10-21", expectedSignalSession: "2026-10-21",
      entryWindowOpen: true, monitorVerifiedAt: 99000, trendQualified: true, atr: 2,
      structuralStop: 98, nav: 10000, cash: 0.0005, holdings: [], leveragedSleevePositions: [],
    })).toMatchObject({ ok: false, reason: "below_minimum_entry" });
  });
});

describe("nonzero position values must not appear as zero", () => {
  it("shows sub-cent values precisely enough without changing true zero or normal amounts", () => {
    expect(fmtMoney(0.0005, "us", 0)).toBe("<$0.01");
    expect(fmtMoney(-0.0001, "us")).toBe("-<$0.01");
    expect(fmtMoney(0.0005, "india")).toBe("<₹0.01");
    expect(fmtMoneyAbbrev(0.0005, "us")).toBe("<$0.01");
    expect(fmtMoney(0, "us", 0)).toBe("$0");
    expect(fmtMoney(123.45, "us")).toBe("$123.45");
  });
});
