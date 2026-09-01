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

// ── OOS acceptance gate (GPT-5 audit remediation) ────────────────────────────
// A model can fit its in-sample data well yet be badly miscalibrated on unseen,
// forward-in-time data. These consts gate the WALK-FORWARD HOLDOUT only. The
// gate is fail-closed: an unvalidatable model (too few holdout rows, degenerate
// outcomes, non-computable error) is NOT accepted.
//
// MIN_OOS_SAMPLES — below this the holdout calibration error is statistical
//   noise, so we refuse rather than accept an unvalidated model. 30 is a floor,
//   not a proven sufficiency level — raise it once real volume exists (needs
//   prospective tuning).
const MIN_OOS_SAMPLES = 30;
// MAX_OOS_ECE — reject when holdout Expected Calibration Error exceeds this.
//   0.1 means predicted P(win) is off by >10 percentage points on average
//   across the reliability bins. A defensible default for a probability that
//   sizes real money; still needs prospective tuning against realized outcomes.
const MAX_OOS_ECE = 0.1;

export interface CalibrationCoefficients {
  intercept: number;
  weights: Record<string, number>; // per DIM
  means: Record<string, number>;
  stdevs: Record<string, number>;
}

export interface CalibrationDecile { decile: number; predictedMean: number; realizedWinRate: number; n: number }

export interface OOSAcceptance {
  accepted: boolean;
  reason: string;
  ece: number | null; // holdout Expected Calibration Error; null when unvalidatable
  nOOS: number;        // usable (sanitized) holdout observations the gate scored
}

export interface FitResult {
  coefficients: CalibrationCoefficients;
  calibration: CalibrationDecile[];
  nObservations: number;
  // OOS acceptance verdict for the walk-forward holdout. REPORTING ONLY — this
  // does not itself gate deployment/promotion; a caller must read `oos.accepted`
  // and decide (see fitAndStoreCalibration and callers).
  oos: OOSAcceptance;
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

// Fit standardization + logistic coefficients from ONE row set. Used both for
// the deployment artifact (all rows) and for each walk-forward fold's train
// partition (so the OOS calibration curve never sees its own test outcomes).
function fitCoefficients(rows: LabeledObservation[]): CalibrationCoefficients {
  const { means, stdevs } = standardize(rows);
  const X = rows.map(r => DIMS.map(dim => (((r as any)[dim] ?? 50) - means[dim]) / stdevs[dim]));
  const y = rows.map(r => ((r.benchmark_neutral_return ?? r.fwd_return ?? 0) > 0 ? 1 : 0));
  const { intercept, coefs } = fitLogistic(X, y);
  const weights: Record<string, number> = {};
  DIMS.forEach((dim, i) => { weights[dim] = coefs[i]; });
  return { intercept, weights, means, stdevs };
}

// Equal-count reliability deciles over (predicted P(win), realized 0/1). Sorts
// ascending by predicted and splits into ~10 buckets, reporting each bucket's
// mean predicted probability vs. its realized win rate. Shared by the honest
// OOS calibration curve and the OOS gate's ECE so there is ONE binning rule.
function reliabilityDeciles(predictions: { predicted: number; realized: number }[]): CalibrationDecile[] {
  const sorted = [...predictions].sort((a, b) => a.predicted - b.predicted);
  const out: CalibrationDecile[] = [];
  const decileSize = Math.max(1, Math.floor(sorted.length / 10));
  for (let d = 0; d < 10 && sorted.length > 0; d++) {
    const slice = sorted.slice(d * decileSize, d === 9 ? undefined : (d + 1) * decileSize);
    if (slice.length === 0) continue;
    out.push({
      decile: d,
      predictedMean: slice.reduce((s, p) => s + p.predicted, 0) / slice.length,
      realizedWinRate: slice.reduce((s, p) => s + p.realized, 0) / slice.length,
      n: slice.length,
    });
  }
  return out;
}

// Expected Calibration Error: the sample-weighted mean gap between predicted
// P(win) and realized win rate across reliability bins. NOT a new metric — it
// is the scalar summary of the same reliability-decile curve the fit reports.
function expectedCalibrationError(deciles: CalibrationDecile[]): number {
  const total = deciles.reduce((s, d) => s + d.n, 0);
  if (total === 0) return NaN;
  return deciles.reduce((s, d) => s + (d.n / total) * Math.abs(d.predictedMean - d.realizedWinRate), 0);
}

// Deterministic OOS acceptance gate (GPT-5 audit remediation). Feed it the
// WALK-FORWARD HOLDOUT predictions (predicted P(win) + realized 0/1). Those are
// forward-in-time by construction: walkForwardFolds only ever predicts test
// rows dated AFTER their train partition, so this is a time-ordered holdout,
// not a random split. Fail-closed on every degenerate input — an unvalidatable
// model is rejected, never accepted by default.
export function acceptCalibrationOOS(oosPredictions: { predicted: number; realized: number }[]): OOSAcceptance {
  // Sanitize first: a NaN/out-of-range prediction or a non-binary outcome must
  // never silently pass the gate. Drop such rows before any statistic.
  const clean = (oosPredictions ?? []).filter(
    p => Number.isFinite(p.predicted) && p.predicted >= 0 && p.predicted <= 1 && (p.realized === 0 || p.realized === 1)
  );
  const nOOS = clean.length;

  // Minimum holdout size — too few rows and the ECE is noise. Fail-closed.
  if (nOOS < MIN_OOS_SAMPLES) {
    return { accepted: false, reason: `insufficient OOS samples (${nOOS} < ${MIN_OOS_SAMPLES})`, ece: null, nOOS };
  }

  // All-same-class holdout (every outcome win, or every outcome loss): the win
  // rate is degenerate and calibration error is not meaningful. Refuse.
  const wins = clean.reduce((s, p) => s + p.realized, 0);
  if (wins === 0 || wins === nOOS) {
    return { accepted: false, reason: "degenerate OOS outcomes (all one class)", ece: null, nOOS };
  }

  const ece = expectedCalibrationError(reliabilityDeciles(clean));
  if (!Number.isFinite(ece)) {
    return { accepted: false, reason: "OOS calibration error not computable", ece: null, nOOS };
  }
  if (ece > MAX_OOS_ECE) {
    return { accepted: false, reason: `OOS calibration error too high (ECE ${ece.toFixed(3)} > ${MAX_OOS_ECE})`, ece, nOOS };
  }
  return { accepted: true, reason: `OOS calibration within tolerance (ECE ${ece.toFixed(3)} <= ${MAX_OOS_ECE}, n=${nOOS})`, ece, nOOS };
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

  // Deployment artifact: fit on ALL eligible history (in-sample refit — this is
  // the model used live for sizing; refitting on all data for deployment is
  // correct AFTER the OOS diagnostic below validates the approach).
  const coefficients = fitCoefficients(rows);

  // Honest OOS calibration curve: fit a SEPARATE model on each fold's TRAIN
  // partition and predict ONLY that fold's TEST partition. Previously the
  // full-data `coefficients` predicted every fold — leakage, because the test
  // rows had influenced the coefficients and the standardization.
  const folds = walkForwardFolds(rows, { folds: 5, testSessions: 30, horizonSessions: horizonDays });
  const predictions: { predicted: number; realized: number }[] = [];
  for (const fold of folds) {
    if (fold.train.length < 30) continue; // too few to fit a trustworthy fold model
    const foldCoeffs = fitCoefficients(fold.train);
    for (const row of fold.test) {
      predictions.push({
        predicted: predictPWin(foldCoeffs, row),
        realized: (row.benchmark_neutral_return ?? row.fwd_return ?? 0) > 0 ? 1 : 0,
      });
    }
  }
  const calibration = reliabilityDeciles(predictions);

  // OOS acceptance gate over the SAME walk-forward holdout predictions. Reported
  // on the result; does not itself block deployment (caller decides).
  const oos = acceptCalibrationOOS(predictions);

  return { coefficients, calibration, nObservations: rows.length, oos };
}

export async function fitAndStoreCalibration(supabase: any, market: "us" | "india", horizonDays: 2 | 5 | 10 | 20 = 10): Promise<{ ok: boolean; reason?: string }> {
  const fit = await fitCalibration(supabase, market, horizonDays);
  if (!fit) return { ok: false, reason: "insufficient_data(<60)" };

  // OOS acceptance gate — fail-closed. A model whose out-of-sample (walk-forward)
  // calibration is bad or unverifiable is NOT written to the live pwin_logistic
  // artifact, so the money path never reads a miscalibrated P(win).
  if (!fit.oos.accepted) {
    return { ok: false, reason: `oos_rejected: ${fit.oos.reason}` };
  }

  const rows = await loadLabeledDataset(supabase, market, horizonDays);
  const datasetHash = crypto.createHash("sha256").update(JSON.stringify(rows.map(r => [r.id, r.fwd_return]))).digest("hex");

  const { error } = await supabase.from("model_artifacts").upsert({
    market, kind: "pwin_logistic", coefficients: fit.coefficients, calibration: fit.calibration,
    n_observations: fit.nObservations, fitted_at: new Date().toISOString(), dataset_hash: datasetHash,
  }, { onConflict: "market,kind" });
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}
