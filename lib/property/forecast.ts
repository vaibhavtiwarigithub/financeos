export type SeriesPoint = { asOf: string; value: number };
export type BaselineForecast = { lower: number; base: number; upper: number; sampleSize: number; method: "drift_uncertainty_v2" };

export type ForecastObservationRow = SeriesPoint & {
  sourceKey: string;
  collectedAt: string;
  revisionState: "initial" | "revised";
};

export type ForecastObservationWindow = {
  sourceKey: string;
  points: SeriesPoint[];
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Select one coherent source series, collapse revisions deterministically, and
 * return the newest bounded window in chronological order for model input.
 */
export function selectForecastObservationWindow(
  rows: readonly ForecastObservationRow[],
  maxPoints = 100,
): ForecastObservationWindow | null {
  if (!Number.isInteger(maxPoints) || maxPoints < 1) throw new RangeError("maxPoints must be a positive integer");
  const bySource = new Map<string, Map<string, ForecastObservationRow>>();
  for (const row of rows) {
    if (!row.sourceKey || !ISO_DATE.test(row.asOf) || !Number.isFinite(row.value) || row.value <= 0) continue;
    const dates = bySource.get(row.sourceKey) ?? new Map<string, ForecastObservationRow>();
    const current = dates.get(row.asOf);
    const rowRank = `${row.collectedAt}|${row.revisionState === "revised" ? "1" : "0"}`;
    const currentRank = current
      ? `${current.collectedAt}|${current.revisionState === "revised" ? "1" : "0"}`
      : "";
    if (!current || rowRank > currentRank) dates.set(row.asOf, row);
    bySource.set(row.sourceKey, dates);
  }

  const candidates = [...bySource.entries()].map(([sourceKey, dates]) => ({
    sourceKey,
    rows: [...dates.values()].sort((a, b) => a.asOf.localeCompare(b.asOf)),
  })).filter((candidate) => candidate.rows.length > 0).sort((a, b) => {
    const latest = b.rows[b.rows.length - 1].asOf.localeCompare(a.rows[a.rows.length - 1].asOf);
    if (latest !== 0) return latest;
    if (a.rows.length !== b.rows.length) return b.rows.length - a.rows.length;
    return a.sourceKey.localeCompare(b.sourceKey);
  });
  const selected = candidates[0];
  if (!selected) return null;
  return {
    sourceKey: selected.sourceKey,
    points: selected.rows.slice(-maxPoints).map(({ asOf, value }) => ({ asOf, value })),
  };
}

/** Infer how many observed periods correspond to the declared day horizon. */
export function inferPeriodsForward(points: readonly SeriesPoint[], horizonDays: number): number | null {
  if (!Number.isInteger(horizonDays) || horizonDays < 1) return null;
  const dates = [...new Set(points.filter((point) => ISO_DATE.test(point.asOf)).map((point) => point.asOf))]
    .sort().map((date) => Date.parse(`${date}T00:00:00.000Z`));
  const gaps = dates.slice(1).map((date, index) => (date - dates[index]) / 86_400_000)
    .filter((gap) => Number.isFinite(gap) && gap > 0).sort((a, b) => a - b);
  if (!gaps.length) return null;
  const middle = Math.floor(gaps.length / 2);
  const medianGap = gaps.length % 2 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2;
  return Math.max(1, Math.min(24, Math.round(horizonDays / medianGap)));
}

export function buildPropertyBaselineForecast(points: SeriesPoint[], periodsForward = 1): BaselineForecast | null {
  const clean = points.filter(p => Number.isFinite(p.value) && p.value > 0 && ISO_DATE.test(p.asOf)).sort((a, b) => a.asOf.localeCompare(b.asOf));
  if (clean.length < 6 || !Number.isInteger(periodsForward) || periodsForward < 1 || periodsForward > 24) return null;
  const returns = clean.slice(1).map((point, index) => point.value / clean[index].value - 1).filter(Number.isFinite);
  if (returns.length < 5) return null;
  const recent = returns.slice(-Math.min(12, returns.length));
  const drift = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  const variance = recent.reduce((sum, value) => sum + (value - drift) ** 2, 0) / Math.max(1, recent.length - 1);
  const uncertainty = Math.sqrt(variance) * Math.sqrt(periodsForward) * 1.96;
  const latest = clean[clean.length - 1].value;
  const base = latest * Math.pow(1 + drift, periodsForward);
  const spread = latest * uncertainty;
  return {
    lower: Math.max(0, base - spread),
    base,
    upper: Math.max(base, base + spread),
    sampleSize: recent.length + 1,
    method: "drift_uncertainty_v2",
  };
}
