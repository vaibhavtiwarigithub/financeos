export type SeriesPoint = { asOf: string; value: number };
export type BaselineForecast = { lower: number; base: number; upper: number; sampleSize: number; method: "drift_uncertainty_v1" };

export function buildPropertyBaselineForecast(points: SeriesPoint[], periodsForward = 1): BaselineForecast | null {
  const clean = points.filter(p => Number.isFinite(p.value) && p.value > 0 && /^\d{4}-\d{2}-\d{2}$/.test(p.asOf)).sort((a, b) => a.asOf.localeCompare(b.asOf));
  if (clean.length < 6 || !Number.isInteger(periodsForward) || periodsForward < 1 || periodsForward > 12) return null;
  const returns = clean.slice(1).map((point, index) => point.value / clean[index].value - 1).filter(Number.isFinite);
  if (returns.length < 5) return null;
  const recent = returns.slice(-Math.min(12, returns.length));
  const drift = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  const variance = recent.reduce((sum, value) => sum + (value - drift) ** 2, 0) / Math.max(1, recent.length - 1);
  const uncertainty = Math.sqrt(variance) * Math.sqrt(periodsForward) * 1.96;
  const latest = clean[clean.length - 1].value;
  const base = latest * Math.max(0.01, 1 + drift * periodsForward);
  return { lower: Math.max(0, latest * (1 + drift * periodsForward - uncertainty)), base, upper: latest * (1 + drift * periodsForward + uncertainty), sampleSize: recent.length + 1, method: "drift_uncertainty_v1" };
}
