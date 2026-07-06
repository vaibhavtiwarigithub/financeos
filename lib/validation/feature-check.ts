// Phase 3 learning-core: pure Spearman rank-IC + significance math for the
// feature-registry promotion job. No DB access here — testable in isolation.

function rank(values: number[]): number[] {
  const idx = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1; // average rank for ties, 1-indexed
    for (let k = i; k <= j; k++) ranks[idx[k]] = avgRank;
    i = j + 1;
  }
  return ranks;
}

// Standard normal CDF via the Abramowitz-Stegun erf approximation.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

export interface ICResult { ic: number; pValue: number; n: number }

// Spearman rank correlation + a Fisher-z-transform two-sided p-value —
// a standard, well-documented significance test for correlation coefficients.
export function computeSpearmanIC(xs: number[], ys: number[]): ICResult | null {
  if (xs.length !== ys.length || xs.length < 5) return null;
  const rx = rank(xs), ry = rank(ys);
  const n = xs.length;
  const meanRx = rx.reduce((a, b) => a + b, 0) / n;
  const meanRy = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - meanRx) * (ry[i] - meanRy);
    denX += (rx[i] - meanRx) ** 2;
    denY += (ry[i] - meanRy) ** 2;
  }
  const denom = Math.sqrt(denX * denY);
  const ic = denom === 0 ? 0 : num / denom;
  if (n < 4 || Math.abs(ic) >= 1) return { ic, pValue: Math.abs(ic) >= 1 ? 0 : 1, n };
  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, ic))) * Math.sqrt(n - 3);
  const pValue = 2 * (1 - normalCdf(Math.abs(z))); // two-sided
  return { ic, pValue, n };
}

// Promotion rule from the spec: |IC| >= 0.03 with p < 0.1, required across at
// least 2 of the given fold results.
export function passesPromotionRule(foldResults: ICResult[], minFoldsPassing = 2): boolean {
  const passing = foldResults.filter(r => Math.abs(r.ic) >= 0.03 && r.pValue < 0.1).length;
  return passing >= minFoldsPassing;
}

// Auto-retire rule: rolling IC below 0.01 for 3 consecutive checks.
export function shouldRetire(recentIcs: number[], threshold = 0.01, consecutive = 3): boolean {
  if (recentIcs.length < consecutive) return false;
  return recentIcs.slice(-consecutive).every(ic => Math.abs(ic) < threshold);
}
