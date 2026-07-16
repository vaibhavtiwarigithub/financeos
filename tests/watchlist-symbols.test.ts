import { describe, expect, it } from "vitest";
import {
  isPlausibleWatchlistSymbol,
  normalizeWatchlistSymbol,
  parseWatchlistCsvSymbols,
} from "@/lib/watchlist-symbols";

describe("watchlist CSV symbols", () => {
  it.each([
    ["BRK.B", "BRK.B"],
    ["M&M", "M&M.NS"],
    ["RELIANCE.NS", "RELIANCE.NS"],
    ["NASDAQ:NVDA", "NVDA"],
    ["nse:reliance", "RELIANCE.NS"],
    ["BSE:500325", "500325.BO"],
    ["  aapl  ", "AAPL"],
    ['"NYSE:IBM"', "IBM"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeWatchlistSymbol(input)).toBe(expected);
  });

  it.each([
    "",
    "junk ticker",
    "$AAPL",
    "UNKNOWN:AAPL",
    "NASDAQ:NVDA:EXTRA",
    "TOOLONGUS",
    "RELIANCE.NS<script>",
    "M&M.NS.extra",
  ])("rejects malformed input %s", input => {
    expect(normalizeWatchlistSymbol(input)).toBeNull();
  });

  it("deduplicates while preserving first-seen order", () => {
    expect(parseWatchlistCsvSymbols("aapl,NASDAQ:AAPL\nNSE:RELIANCE\nRELIANCE.NS"))
      .toEqual(["AAPL", "RELIANCE.NS"]);
  });

  it("allows the supported US and India symbol shapes", () => {
    expect(isPlausibleWatchlistSymbol("BRK-B")).toBe(true);
    expect(isPlausibleWatchlistSymbol("M&MFIN.NS")).toBe(true);
    expect(isPlausibleWatchlistSymbol("RELIANCE")).toBe(false);
  });
});
