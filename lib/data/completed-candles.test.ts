import { describe, expect, it } from "vitest";
import { completedSessionCandles } from "@/lib/data/completed-candles";
import type { Candle } from "@/lib/data/technicals";

const candle = (date: string): Candle => ({ date, open: 1, high: 2, low: 1, close: 2, volume: 10 });

describe("completedSessionCandles", () => {
  it("strips a US current-session daily bar before the close", () => {
    const rows = [candle("2026-07-30"), candle("2026-07-31")];
    expect(completedSessionCandles(rows, "us", new Date("2026-07-31T19:59:00Z")).map((row) => row.date))
      .toEqual(["2026-07-30"]);
  });

  it("admits a US current-session bar at the regular close", () => {
    const rows = [candle("2026-07-30"), candle("2026-07-31")];
    expect(completedSessionCandles(rows, "us", new Date("2026-07-31T20:00:00Z")).map((row) => row.date))
      .toEqual(["2026-07-30", "2026-07-31"]);
  });

  it("uses the India close and rejects malformed or future dates", () => {
    const rows = [candle("bad"), candle("2026-07-30"), candle("2026-07-31"), candle("2026-08-01")];
    expect(completedSessionCandles(rows, "india", new Date("2026-07-31T09:59:00Z")).map((row) => row.date))
      .toEqual(["2026-07-30"]);
    expect(completedSessionCandles(rows, "india", new Date("2026-07-31T10:00:00Z")).map((row) => row.date))
      .toEqual(["2026-07-30", "2026-07-31"]);
  });
});
