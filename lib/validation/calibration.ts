// Phase 2 learning-core: calibrated P(win) model — a logistic regression fit
// (plain gradient descent, no new deps) over the 5 dimension scores, target =
// benchmark_neutral_return > 0. This REPLACES the raw analyst_score (which is
// an uncalibrated weighted sum, not a probability) as the sizing input.
//
// Deterministic, walk-forward evaluated. No LLM. Standardizes features (zero
// mean, unit stdev) so the coefficients are comparable across dimensions.

import crypto from "crypto";
import { loadLabeledDataset, walkForwardFolds, type LabeledObservation } from "@/lib/learning/dataset";

const DIMS = ["fundamental_score", "technical_score", "sentiment_score", "macro_score", "insider_score"] as const;

export interface CalibrationCoefficients {
  intercept: number;
  weights: Record<string, number>; // per DIM
  means: Record<string, number>;
  stdevs: Record<string, number>;
}

export interface CalibrationDecile { decile: number; predictedMean: number; realizedWinRate: number; n: number }

export interface FitResult {
  coefficients: CalibrationCoefficients;
  calibration: CalibrationDecile[];
  nObservations: number;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function standardize(rows: LabeledObservation[]): { means: Record<string, number>; stdevs: Record<string, number> } {
  const means: Record<string, number> = {};
  const stdevs: Record<string, number> = {};
  for (const dim of DIMS) {
    const vals = rows.map(r => (r as any)[dim] ?? 50);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    means[dim] = mean;
    stdevs[dim] = Math.sqrt(variance) || 1;
  }
  return { means, stdevs };
}

// Plain batch gradient descent logistic regression. Deterministic (no
// randomness) — same input always produces the same fit.
function fitLogistic(X: number[][], y: number[], iterations = 500, lr = 0.1): { intercept: number; coefs: number[] } {
  const n = X.length, d = X[0]?.length ?? 0;
  let intercept = 0;
  let coefs = new Array(d).fill(0);
  for (let iter = 0; iter < iterations; iter++) {
    let gradIntercept = 0;
    const gradCoefs = new Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      const z = intercept + X[i].reduce((s, x, j) => s + x * coefs[j], 0);
      const pred = sigmoid(z);
      const err = pred - y[i];
      gradIntercept += err;
      for (let j = 0; j < d; j++) gradCoefs[j] += err * X[i][j];
    }
    intercept -= (lr * gradIntercept) / n;
    coefs = coefs.map((c, j) => c - (lr * gradCoefs[j]) / n);
  }
  return { intercept, coefs };
}

export function predictPWin(coeffs: CalibrationCoefficients, row: Partial<LabeledObservation>): number {
  let z = coeffs.intercept;
  for (const dim of DIMS) {
    const raw = (row as any)[dim] ?? 50;
    const standardized = (raw - coeffs.means[dim]) / (coeffs.stdevs[dim] || 1);
    z += standardized * coeffs.weights[dim];
  }
  return sigmoid(z);
}

export async function fitCalibration(supabase: any, market: "us" | "india", horizonDays: 2 | 5 | 10 | 20 = 10): Promise<FitResult | null> {
  const rows = await loadLabeledDataset(supabase, market, horizonDays);
  if (rows.length < 60) return null;

  const { means, stdevs } = standardize(rows);
  const X = rows.map(r => DIMS.map(dim => (((r as any)[dim] ?? 50) - means[dim]) / stdevs[dim]));
  const y = rows.map(r => ((r.benchmark_neutral_return ?? r.fwd_return ?? 0) > 0 ? 1 : 0));

  const { intercept, coefs } = fitLogistic(X, y);
  const weights: Record<string, number> = {};
  DIMS.forEach((dim, i) => { weights[dim] = coefs[i]; });
  const coefficients: CalibrationCoefficients = { intercept, weights, means, stdevs };

  // Walk-forward calibration curve: predicted decile vs realized win rate,
  // computed OUT OF SAMPLE using the same fold structure as the validation engine.
  const folds = walkForwardFolds(rows, { folds: 5, testDays: 30, horizonDays });
  const predictions: { predicted: number; realized: number }[] = [];
  for (const fold of folds) {
    for (const row of fold.test) {
      predictions.push({
        predicted: predictPWin(coefficients, row),
        realized: (row.benchmark_neutral_return ?? row.fwd_return ?? 0) > 0 ? 1 : 0,
      });
    }
  }
  predictions.sort((a, b) => a.predicted - b.predicted);
  const calibration: CalibrationDecile[] = [];
  const decileSize = Math.max(1, Math.floor(predictions.length / 10));
  for (let d = 0; d < 10 && predictions.length > 0; d++) {
    const slice = predictions.slice(d * decileSize, d === 9 ? undefined : (d + 1) * decileSize);
    if (slice.length === 0) continue;
    calibration.push({
      decile: d,
      predictedMean: slice.reduce((s, p) => s + p.predicted, 0) / slice.length,
      realizedWinRate: slice.reduce((s, p) => s + p.realized, 0) / slice.length,
      n: slice.length,
    });
  }

  return { coefficients, calibration, nObservations: rows.length };
}

export async function fitAndStoreCalibration(supabase: any, market: "us" | "india", horizonDays: 2 | 5 | 10 | 20 = 10): Promise<{ ok: boolean; reason?: string }> {
  const fit = await fitCalibration(supabase, market, horizonDays);
  if (!fit) return { ok: false, reason: "insufficient_data(<60)" };

  const rows = await loadLabeledDataset(supabase, market, horizonDays);
  const datasetHash = crypto.createHash("sha256").update(JSON.stringify(rows.map(r => [r.id, r.fwd_return]))).digest("hex");

  const { error } = await supabase.from("model_artifacts").upsert({
    market, kind: "pwin_logistic", coefficients: fit.coefficients, calibration: fit.calibration,
    n_observations: fit.nObservations, fitted_at: new Date().toISOString(), dataset_hash: datasetHash,
  }, { onConflict: "market,kind" });
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}
