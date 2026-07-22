import { describe, it, expect } from "vitest";
import { newestBarIsStale } from "@/lib/data/candles";

function bar(date: string) {
  return { date, open: 100, high: 110, low: 90, close: 105, volume: 1000000 };
}

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

describe("newestBarIsStale", () => {
  it("empty series is stale", () => {
    expect(newestBarIsStale([])).toBe(true);
  });

  it("today's bar is fresh", () => {
    expect(newestBarIsStale([bar(daysAgo(0))])).toBe(false);
  });

  it("yesterday's bar is fresh", () => {
    expect(newestBarIsStale([bar(daysAgo(1))])).toBe(false);
  });

  it("3-day-old bar is fresh (long weekend)", () => {
    expect(newestBarIsStale([bar(daysAgo(3))])).toBe(false);
  });

  it("4-day-old bar is fresh (edge of window)", () => {
    expect(newestBarIsStale([bar(daysAgo(4))])).toBe(false);
  });

  it("5-day-old bar is stale (the Massive cache bug scenario)", () => {
    expect(newestBarIsStale([bar(daysAgo(5))])).toBe(true);
  });

  it("uses only the last bar in the series", () => {
    const series = [bar(daysAgo(30)), bar(daysAgo(10)), bar(daysAgo(1))];
    expect(newestBarIsStale(series)).toBe(false);
  });

  it("stale if all bars are old", () => {
    const series = [bar(daysAgo(20)), bar(daysAgo(10)), bar(daysAgo(6))];
    expect(newestBarIsStale(series)).toBe(true);
  });
});
