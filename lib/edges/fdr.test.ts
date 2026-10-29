import { describe, expect, it } from "vitest";
import { benjaminiYekutieli, studentTTwoSidedPValue } from "./fdr";

describe("studentTTwoSidedPValue", () => {
  it("matches standard reference values", () => {
    expect(studentTTwoSidedPValue(0, 10)).toBeCloseTo(1, 12);
    expect(studentTTwoSidedPValue(2.22813885, 10)).toBeCloseTo(0.05, 6);
    expect(studentTTwoSidedPValue(3, 1)).toBeCloseTo(0.20483276, 6);
  });

  it("rejects invalid degrees of freedom and non-finite inputs", () => {
    expect(() => studentTTwoSidedPValue(1, 0)).toThrow("degrees of freedom");
    expect(() => studentTTwoSidedPValue(Number.NaN, 10)).toThrow("degrees of freedom");
  });
});

describe("Benjamini-Yekutieli family adjustment", () => {
  it("is stable, preserves input order, and is conservative for dependent tests", () => {
    const result = benjaminiYekutieli([
      { id: "b", pValue: 0.04 },
      { id: "a", pValue: 0.01 },
      { id: "c", pValue: 0.03 },
    ], 0.05);
    expect(result.map((row) => row.id)).toEqual(["b", "a", "c"]);
    expect(result[0].qValue).toBeCloseTo(0.07333333333333333, 12);
    expect(result[1].qValue).toBeCloseTo(0.055, 12);
    expect(result[2].qValue).toBeCloseTo(0.07333333333333333, 12);
    expect(result.every((row) => row.rejected)).toBe(false);
  });

  it("rejects malformed families", () => {
    expect(() => benjaminiYekutieli([{ id: "x", pValue: 1.1 }], 0.05)).toThrow("Invalid p-value");
    expect(() => benjaminiYekutieli([{ id: "x", pValue: 0.1 }], 1)).toThrow("alpha");
  });
});
