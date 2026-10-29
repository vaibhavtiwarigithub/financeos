import { describe, expect, it } from "vitest";
import { neweyWestLag } from "./evidence";

describe("overlap-derived Newey-West lag", () => {
  it("uses zero for non-overlapping windows and horizon/step minus one for overlap", () => {
    expect(neweyWestLag(5, 5)).toBe(0);
    expect(neweyWestLag(10, 5)).toBe(1);
    expect(neweyWestLag(20, 5)).toBe(3);
    expect(neweyWestLag(20, 1)).toBe(19);
  });
});
