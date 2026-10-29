/** Benjamini-Hochberg adjustment for a predeclared family of two-sided tests. */
export interface FdrInput { id: string; pValue: number }
export interface FdrResult extends FdrInput { qValue: number; rejected: boolean }

function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIterations = 200;
  const epsilon = 3e-14;
  const tiny = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) return h;
  }
  throw new Error("Incomplete beta calculation did not converge.");
}

function logGamma(z: number): number {
  // Lanczos approximation; coefficients are fixed constants, no runtime dependency.
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  let x = 0.99999999999980993;
  const shifted = z - 1;
  for (let i = 0; i < coefficients.length; i++) x += coefficients[i] / (shifted + i + 1);
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return front * betaContinuedFraction(a, b, x) / a;
  }
  return 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
}

/** Two-sided Student-t p-value; df must reflect the dated IC observations. */
export function studentTTwoSidedPValue(t: number, degreesOfFreedom: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(degreesOfFreedom) || degreesOfFreedom < 1) {
    throw new Error("Finite t-statistic and degrees of freedom >= 1 are required.");
  }
  const df = degreesOfFreedom;
  const x = df / (df + t * t);
  return regularizedIncompleteBeta(x, df / 2, 0.5);
}

/** Stable BY q-values control FDR under arbitrary dependence. */
export function benjaminiYekutieli(
  inputs: readonly FdrInput[],
  alpha: number,
): FdrResult[] {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) throw new Error("FDR alpha must be between 0 and 1.");
  const seen = new Set<string>();
  for (const item of inputs) {
    if (!item.id || seen.has(item.id)) throw new Error("FDR test IDs must be non-empty and unique.");
    if (!Number.isFinite(item.pValue) || item.pValue < 0 || item.pValue > 1) throw new Error(`Invalid p-value for ${item.id}.`);
    seen.add(item.id);
  }
  const ordered = [...inputs].sort((a, b) => a.pValue - b.pValue || a.id.localeCompare(b.id));
  const dependencePenalty = ordered.reduce((sum, _, index) => sum + 1 / (index + 1), 0);
  let priorQ = 1;
  const qById = new Map<string, number>();
  for (let i = ordered.length - 1; i >= 0; i--) {
    const candidate = Math.min(1, ordered[i].pValue * ordered.length * dependencePenalty / (i + 1));
    priorQ = Math.min(priorQ, candidate);
    qById.set(ordered[i].id, priorQ);
  }
  return inputs.map((item) => {
    const qValue = qById.get(item.id)!;
    return { ...item, qValue, rejected: qValue <= alpha };
  });
}
