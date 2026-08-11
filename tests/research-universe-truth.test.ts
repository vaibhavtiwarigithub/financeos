import { describe, expect, it } from "vitest";
import {
  breakdownWithStatus,
  finiteNumber,
} from "@/lib/research/universe-truth";

describe("research universe truth serialization", () => {
  it("does not turn missing scores into measured zeroes", () => {
    expect(finiteNumber(null)).toBeNull();
    expect(finiteNumber("")).toBeNull();
    expect(finiteNumber("not-a-score")).toBeNull();
    expect(finiteNumber("72")).toBe(72);
  });

  it("marks legacy evidence available only when a real domain value exists", () => {
    expect(breakdownWithStatus({ pe_ratio: 18 }, "fundamental", "us"))
      .toMatchObject({ status: "available", pe_ratio: 18 });
    expect(breakdownWithStatus({ pe_ratio: null }, "fundamental", "us"))
      .toMatchObject({ status: "unavailable" });
  });

  it("keeps India sentiment and macro structurally inapplicable", () => {
    expect(breakdownWithStatus({ danger_score: 25 }, "macro", "india"))
      .toMatchObject({ status: "inapplicable" });
    expect(breakdownWithStatus({ bullish_pct: 80 }, "sentiment", "india"))
      .toMatchObject({ status: "inapplicable" });
  });

  it("reconstructs active EMA-position inputs for legacy technical rows", () => {
    expect(breakdownWithStatus({ price: 105, ema20: 100, ema50: 110 }, "technical", "us"))
      .toMatchObject({ status: "available", price_vs_ema20: "above", price_vs_ema50: "below" });
  });

  it("preserves an explicit status written by the scoring run", () => {
    expect(breakdownWithStatus({ status: "inapplicable", pe_ratio: null }, "fundamental", "us"))
      .toMatchObject({ status: "inapplicable" });
  });
});
