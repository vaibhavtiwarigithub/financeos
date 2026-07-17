import { describe, it, expect } from "vitest";
import { actualSpanDays, isShortHistory, spansRequestedWindow } from "./history-span";

const rows = (...dates: string[]) => dates.map((date) => ({ date }));

// The real price_cache state that motivates this: QQQ, DIA, VIXY and every
// XLK..XLC sector ETF hold exactly 2 bars (2026-07-14 → 2026-07-15), while SPY
// holds 222. The old guard (`rows.length > 0 && isFresh(newest)`) passed on the
// 2-bar symbols for ANY requested window.
const TWO_BAR = rows("2026-07-14", "2026-07-15");

function sixMonthsOfBars(): { date: string }[] {
  const out: { date: string }[] = [];
  const start = Date.UTC(2026, 0, 16);
  for (let i = 0; i < 180; i++) {
    out.push({ date: new Date(start + i * 86400000).toISOString().slice(0, 10) });
  }
  return out;
}

describe("actualSpanDays", () => {
  it("measures the calendar days covered, not the bar count", () => {
    expect(actualSpanDays(TWO_BAR)).toBe(1);
    expect(actualSpanDays(rows("2026-01-16", "2026-07-15"))).toBe(180);
  });

  it("returns 0 for a single bar — one bar spans no window", () => {
    expect(actualSpanDays(rows("2026-07-15"))).toBe(0);
    expect(actualSpanDays([])).toBe(0);
  });
});

describe("spansRequestedWindow — the count-not-span guard", () => {
  it("REJECTS a 2-bar symbol for a 180-day request", () => {
    // This is the bug: 2 bars satisfied `rows.length > 0`, short-circuited the
    // REST backfill, and produced a "6M" return computed over ONE day.
    expect(spansRequestedWindow(TWO_BAR, 180)).toBe(false);
  });

  it("REJECTS a 2-bar symbol for every offered period, including 1W", () => {
    for (const days of [7, 30, 90, 180]) {
      expect(spansRequestedWindow(TWO_BAR, days), `days=${days}`).toBe(false);
    }
  });

  it("ACCEPTS a genuinely full 6-month cache for a 180-day request", () => {
    expect(spansRequestedWindow(sixMonthsOfBars(), 180)).toBe(true);
  });

  it("ACCEPTS a cache that covers most of the window (weekends/holidays)", () => {
    // 120 calendar days of a 180-day window = 67% > the 60% floor.
    expect(spansRequestedWindow(rows("2026-03-17", "2026-07-15"), 180)).toBe(true);
  });

  it("REJECTS a cache covering only a third of the window", () => {
    expect(spansRequestedWindow(rows("2026-06-15", "2026-07-15"), 180)).toBe(false);
  });

  it("REJECTS a single bar regardless of window", () => {
    expect(spansRequestedWindow(rows("2026-07-15"), 7)).toBe(false);
    expect(spansRequestedWindow([], 7)).toBe(false);
  });
});

describe("isShortHistory — labelling honesty", () => {
  it("flags a 2-bar series as short for a 6M request, so it is not labelled 6M", () => {
    expect(isShortHistory(TWO_BAR, 180)).toBe(true);
  });

  it("does not flag a full 6M series", () => {
    expect(isShortHistory(sixMonthsOfBars(), 180)).toBe(false);
  });

  it("treats a single bar as short — a return cannot be computed at all", () => {
    expect(isShortHistory(rows("2026-07-15"), 30)).toBe(true);
  });
});
