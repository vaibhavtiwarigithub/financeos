import { describe, expect, it } from "vitest";
import { extractBriefingTickers } from "@/lib/briefing-tickers";

describe("extractBriefingTickers", () => {
  it("extracts ordinary and explicitly prefixed long symbols", () => {
    expect(extractBriefingTickers("Watch AAPL and $HDFCBANK, not GDP.")).toEqual(["AAPL", "HDFCBANK"]);
  });

  it("does not turn long all-caps prose into ticker suggestions", () => {
    expect(extractBriefingTickers("PORTFOLIO EARNINGS OUTLOOK")).toEqual([]);
  });

  it("accepts a long unprefixed symbol only when it is already known", () => {
    expect(extractBriefingTickers("RELIANCE remains under review.", ["RELIANCE"])).toEqual(["RELIANCE"]);
    expect(extractBriefingTickers("RELIANCE remains under review.")).toEqual([]);
  });

  it("never extracts a trailing substring from a longer word", () => {
    expect(extractBriefingTickers("RELIANCE", ["AANCE"])).toEqual([]);
  });
});
