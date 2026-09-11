import { describe, expect, it } from "vitest";
import { guardianUsExitQuantity } from "@/lib/trading/guardian-protection-monitor";

describe("guardianUsExitQuantity", () => {
  it("preserves a fractional Robinhood holding without rounding up", () => {
    expect(guardianUsExitQuantity(0.7500009)).toBe(0.75);
  });

  it("refuses invalid or dust quantities", () => {
    expect(guardianUsExitQuantity(0)).toBeNull();
    expect(guardianUsExitQuantity(Number.NaN)).toBeNull();
  });
});
