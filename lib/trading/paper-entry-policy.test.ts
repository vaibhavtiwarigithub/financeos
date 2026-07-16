import { describe, expect, it } from "vitest";
import { canOpenPaperName, DEFAULT_MAX_ALPHA_NAMES_PER_MARKET } from "./paper-entry-policy";

describe("paper entry name cap", () => {
  it("allows a new name below the cap", () => {
    expect(canOpenPaperName(["AAPL", "MSFT"], "NVDA")).toBe(true);
  });

  it("blocks a new name at the cap", () => {
    const names = Array.from({ length: DEFAULT_MAX_ALPHA_NAMES_PER_MARKET }, (_, i) => `S${i}`);
    expect(canOpenPaperName(names, "NEW")).toBe(false);
  });

  it("allows a pyramid without increasing the name count", () => {
    const names = Array.from({ length: DEFAULT_MAX_ALPHA_NAMES_PER_MARKET }, (_, i) => `S${i}`);
    expect(canOpenPaperName(names, "s0")).toBe(true);
  });

  it("uses the supplied per-market cap and fails invalid values back to 10", () => {
    expect(canOpenPaperName(["A", "B"], "C", 2)).toBe(false);
    expect(canOpenPaperName(Array.from({ length: 9 }, (_, i) => `S${i}`), "NEW", Number.NaN)).toBe(true);
  });
});
