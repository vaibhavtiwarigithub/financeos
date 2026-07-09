// Edge/Factor Discovery P0 — cross-sectional standardization. MEASURE-ONLY.
// Standard pre-IC step: winsorize the cross-section (clip outliers), then z-score
// so edges are comparable. Applied per (date, market, edge) across all symbols.

/** Clip values to the [p, 1-p] empirical quantiles (default 2%). Pure. */
export function winsorize(xs: number[], p = 0.02): number[] {
  const finite = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (finite.length < 3) return xs.slice();
  const lo = finite[Math.floor(p * (finite.length - 1))];
  const hi = finite[Math.ceil((1 - p) * (finite.length - 1))];
  return xs.map(x => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : x));
}

/**
 * Cross-sectional z-score. Winsorizes first, then standardizes to mean 0 / std 1.
 * Non-finite inputs map to null. If std is 0 (no dispersion) every finite value
 * maps to 0 (no signal), never NaN.
 */
export function crossSectionalZ(raw: number[]): (number | null)[] {
  const w = winsorize(raw);
  const finite = w.filter(x => Number.isFinite(x)) as number[];
  if (finite.length < 2) return raw.map(x => (Number.isFinite(x) ? 0 : null));
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  const variance = finite.reduce((a, b) => a + (b - mean) ** 2, 0) / finite.length;
  const std = Math.sqrt(variance);
  return w.map(x => {
    if (!Number.isFinite(x)) return null;
    return std > 0 ? (x - mean) / std : 0;
  });
}
