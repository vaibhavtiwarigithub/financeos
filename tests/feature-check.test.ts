import { describe, it, expect } from "vitest";
import { computeSpearmanIC, passesPromotionRule, shouldRetire } from "@/lib/validation/feature-check";

describe("computeSpearmanIC", () => {
  it("returns IC close to 1 for a perfectly monotonic relationship", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ys = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
    const result = computeSpearmanIC(xs, ys);
    expect(result).not.toBeNull();
    expect(result!.ic).toBeCloseTo(1, 5);
    expect(result!.pValue).toBeLessThan(0.05);
  });

  it("returns IC close to -1 for a perfectly inverse relationship", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ys = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const result = computeSpearmanIC(xs, ys);
    expect(result!.ic).toBeCloseTo(-1, 5);
  });

  it("returns a small IC with a large p-value for unrelated/noisy data", () => {
    const xs = [1, 5, 2, 8, 3, 7, 4, 6, 9, 10];
    const ys = [5, 1, 8, 2, 7, 3, 6, 4, 10, 9];
    const result = computeSpearmanIC(xs, ys);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.ic)).toBeLessThan(0.5);
  });

  it("returns null for too few observations (n<5)", () => {
    expect(computeSpearmanIC([1, 2], [1, 2])).toBeNull();
  });

  it("returns null when array lengths mismatch", () => {
    expect(computeSpearmanIC([1, 2, 3], [1, 2])).toBeNull();
  });

  it("handles tied ranks without throwing", () => {
    const result = computeSpearmanIC([1, 1, 1, 2, 2], [1, 2, 1, 2, 3]);
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!.ic)).toBe(true);
  });
});

describe("passesPromotionRule", () => {
  it("passes when >= 2 folds meet |IC|>=0.03 and p<0.1", () => {
    const folds = [{ ic: 0.05, pValue: 0.02, n: 100 }, { ic: 0.04, pValue: 0.03, n: 100 }, { ic: 0.01, pValue: 0.5, n: 100 }];
    expect(passesPromotionRule(folds)).toBe(true);
  });

  it("fails when only 1 fold meets the bar", () => {
    const folds = [{ ic: 0.05, pValue: 0.02, n: 100 }, { ic: 0.01, pValue: 0.6, n: 100 }, { ic: 0.01, pValue: 0.5, n: 100 }];
    expect(passesPromotionRule(folds)).toBe(false);
  });
});

describe("shouldRetire", () => {
  it("retires when the last 3 rolling ICs are all below the threshold", () => {
    expect(shouldRetire([0.05, 0.005, 0.003, 0.001])).toBe(true);
  });

  it("does not retire if any of the last 3 is above the threshold", () => {
    expect(shouldRetire([0.005, 0.003, 0.05, 0.001])).toBe(false);
  });

  it("does not retire with insufficient history", () => {
    expect(shouldRetire([0.001, 0.001])).toBe(false);
  });
});
