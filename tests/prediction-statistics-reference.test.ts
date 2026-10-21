import { describe, expect, it } from "vitest";
import { hacMeanT } from "@/lib/score-variants/core";

// Independent quadratic-form implementation of the Bartlett sandwich for a
// regression on an intercept, WITHOUT finite-sample correction. This is the
// convention of statsmodels cov_hac(..., use_correction=false), not its default.
// https://www.statsmodels.org/stable/generated/statsmodels.stats.sandwich_covariance.cov_hac.html
function matrixReference(values: number[], lag: number, positions = values.map((_, i) => i)) {
  const n = values.length, mean = values.reduce((a, b) => a + b, 0) / n;
  const centered = values.map((v) => v - mean);
  const meat = centered.reduce((total, a, i) => total + centered.reduce((sum, b, j) => {
    const distance = Math.abs(positions[i] - positions[j]);
    const weight = distance <= lag ? 1 - distance / (lag + 1) : 0;
    return sum + a * b * weight;
  }, 0), 0);
  return meat > 0 ? mean / Math.sqrt(meat / (n * n)) : null;
}

function normalGenerator(seed: number) {
  let state = seed >>> 0;
  const uniform = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return (state + 0.5) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

describe("Prediction Lab numerical reference and null audit", () => {
  it("matches a full Bartlett covariance matrix with and without session gaps", () => {
    const values = [0.03, -0.07, 0.12, 0.04, -0.01, 0.08];
    for (const lag of [0, 1, 2, 5]) expect(hacMeanT(values, lag)).toBeCloseTo(matrixReference(values, lag)!, 12);
    const positions = [0, 1, 4, 5, 11, 12];
    for (const lag of [0, 2, 9]) expect(hacMeanT(values, lag, positions)).toBeCloseTo(matrixReference(values, lag, positions)!, 12);
    expect(hacMeanT([1, 1, 1], 2)).toBeNull();
    expect(hacMeanT([1, NaN, 2], 2)).toBeNull();
  });

  it("demonstrates why descriptive HAC t is NOT a normal-reference significance test", () => {
    const repetitions = 1000;
    const results = [{ n: 120, h: 1 }, { n: 24, h: 10 }, { n: 120, h: 10 }].map(({ n, h }, index) => {
      const normal = normalGenerator(20261021 + index);
      let rejected = 0, finite = 0;
      for (let run = 0; run < repetitions; run++) {
        const innovations = Array.from({ length: n + h - 1 }, normal);
        const overlapping = Array.from({ length: n }, (_, start) => innovations.slice(start, start + h).reduce((a, b) => a + b, 0) / Math.sqrt(h));
        const t = hacMeanT(overlapping, h - 1);
        if (t == null) continue;
        finite++;
        if (Math.abs(t) > 1.96) rejected++;
      }
      return { n, h, finite, normalReferenceRejectionRate: rejected / finite };
    });
    expect(results.every((r) => r.finite === repetitions)).toBe(true);
    expect(results[0].normalReferenceRejectionRate).toBeGreaterThan(0.025);
    expect(results[0].normalReferenceRejectionRate).toBeLessThan(0.085);
    expect(results[1].normalReferenceRejectionRate).toBeGreaterThan(0.085);
    expect(results[2].normalReferenceRejectionRate).toBeGreaterThan(0.085);
    console.info("HAC null audit (not a calibrated inferential reference):", JSON.stringify(results));
    // No critical value, confidence interval or promotion gate is fitted here.
    // Confirmation still needs a declared inference/precision design, calibrated
    // for its serial dependence and multiplicity; this fixture does NOT supply it.
  });
});
