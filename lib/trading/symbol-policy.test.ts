import { describe, expect, it } from "vitest";
import { isLeveragedInverseEtf } from "@/lib/trading/symbol-policy";

describe("generic tradable-universe policy", () => {
  it.each(["SH", "PSQ", "DOG", "RWM", "SQQQ", "TQQQ"])(
    "blocks inverse or leveraged ETF %s from generic agents",
    (symbol) => expect(isLeveragedInverseEtf(symbol)).toBe(true),
  );

  it("normalizes symbol casing and whitespace", () => {
    expect(isLeveragedInverseEtf("  sh ")).toBe(true);
  });

  it("does not block an ordinary broad-market ETF", () => {
    expect(isLeveragedInverseEtf("VOO")).toBe(false);
  });
});
