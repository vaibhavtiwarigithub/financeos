import { describe, expect, it } from "vitest";
import { isReviewedAdr, isUnsupportedAdrProxy, reviewedAdr } from "@/lib/instruments/adrs";

describe("reviewed ADR registry", () => {
  it("records SKHY as the current Nasdaq ADS with its conversion ratio", () => {
    expect(isReviewedAdr("skhy")).toBe(true);
    expect(reviewedAdr("SKHY")).toMatchObject({
      underlyingSymbol: "000660.KS",
      usExchange: "NASDAQ",
      adsToOrdinaryShareRatio: 0.1,
    });
  });

  it.each(["SKHYV", "HXSCL", "HXSCF"])("rejects obsolete or OTC proxy %s", (symbol) => {
    expect(isReviewedAdr(symbol)).toBe(false);
    expect(isUnsupportedAdrProxy(symbol)).toBe(true);
  });
});
