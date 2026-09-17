import { describe, expect, it } from "vitest";
import { deriveCryptoResearchShadow } from "./crypto-research-shadow";

function candles(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.6;
    return { date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`, open: close - 0.4, high: close + 1.2, low: close - 1, close, volume: 1_000 };
  });
}

describe("deriveCryptoResearchShadow", () => {
  it("uses only completed supplied bars and produces bounded deterministic evidence", () => {
    const first = deriveCryptoResearchShadow(candles(55));
    const second = deriveCryptoResearchShadow(candles(55));
    expect(first).toEqual(second);
    expect(first).toMatchObject({ close: 132.4 });
    expect(first!.trendScore).toBeGreaterThanOrEqual(0);
    expect(first!.trendScore).toBeLessThanOrEqual(100);
    expect(first!.atrPct).toBeGreaterThan(0);
  });

  it("refuses insufficient or invalid bar history", () => {
    expect(deriveCryptoResearchShadow(candles(50))).toBeNull();
    const invalid = candles(55);
    for (let index = 0; index < 5; index += 1) invalid[index].close = 0;
    expect(deriveCryptoResearchShadow(invalid)).toBeNull();
  });
});
