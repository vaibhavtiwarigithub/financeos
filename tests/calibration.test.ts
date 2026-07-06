import { describe, it, expect } from "vitest";
import { predictPWin, type CalibrationCoefficients } from "@/lib/validation/calibration";

const coeffs: CalibrationCoefficients = {
  intercept: 0,
  weights: { fundamental_score: 1, technical_score: 0, sentiment_score: 0, macro_score: 0, insider_score: 0 },
  means: { fundamental_score: 50, technical_score: 50, sentiment_score: 50, macro_score: 50, insider_score: 50 },
  stdevs: { fundamental_score: 10, technical_score: 10, sentiment_score: 10, macro_score: 10, insider_score: 10 },
};

describe("predictPWin", () => {
  it("returns 0.5 when the row's fundamental score equals the mean (z=0)", () => {
    const p = predictPWin(coeffs, { fundamental_score: 50 } as any);
    expect(p).toBeCloseTo(0.5, 5);
  });

  it("returns a higher probability for an above-mean fundamental score with a positive weight", () => {
    const high = predictPWin(coeffs, { fundamental_score: 70 } as any);
    const low = predictPWin(coeffs, { fundamental_score: 30 } as any);
    expect(high).toBeGreaterThan(0.5);
    expect(low).toBeLessThan(0.5);
    expect(high).toBeGreaterThan(low);
  });

  it("always returns a value in (0, 1) across the realistic 0-100 score range", () => {
    const p = predictPWin(coeffs, { fundamental_score: 100 } as any);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it("defaults missing dimension scores to 50 (neutral, z=0 contribution)", () => {
    const withMissing = predictPWin(coeffs, {} as any);
    expect(withMissing).toBeCloseTo(0.5, 5);
  });
});
