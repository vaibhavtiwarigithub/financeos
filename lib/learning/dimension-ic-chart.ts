/**
 * Chart assembly for the Dimension Rank IC panel (/dashboard/learning).
 *
 * Pure, display-only shaping — nothing here reaches a score, size, exit or
 * order. It lives in lib/ rather than inside the component so it is covered by
 * the test globs and can be checked without a DOM.
 */

export type SessionPoint = { date: string; ic: number; cross_section: number };
export type ChartRow = Record<string, string | number | null>;

/** Trailing mean over the last `window` sessions — the line to read for direction. */
export function rollingMean(series: SessionPoint[], window: number): Array<number | null> {
  return series.map((_, index) => {
    if (index + 1 < window) return null;
    const slice = series.slice(index + 1 - window, index + 1);
    return slice.reduce((sum, point) => sum + point.ic, 0) / slice.length;
  });
}

/** Window used for the focused dimension's rolling overlay. */
export function rollingWindow(sessionCount: number): number {
  return Math.min(10, Math.max(2, Math.floor(sessionCount / 3)));
}

/**
 * Union every selected dimension's sessions onto one date axis.
 *
 * Dimensions qualify on DIFFERENT days — availability differs, so insider has
 * 21 sessions in production where sentiment has 29 — which means a date present
 * for one line is genuinely absent for another. Absent dates are left undefined
 * so recharts (connectNulls={false}) breaks the line there. Filling them with 0
 * or interpolating would draw an observation on a day the dimension was never
 * measured — the same class of error as charting the expanding mean.
 */
export function buildChartRows(
  series: Array<{ key: string; points: SessionPoint[] }>,
  rollingFor?: string,
): ChartRow[] {
  const dates = new Set<string>();
  for (const entry of series) for (const point of entry.points) dates.add(point.date);
  const axis = [...dates].sort();
  const index = new Map(axis.map((date, i) => [date, i]));
  const rows: ChartRow[] = axis.map((date) => ({ date }));
  for (const entry of series) {
    for (const point of entry.points) rows[index.get(point.date)!][entry.key] = point.ic;
    if (rollingFor && entry.key === rollingFor) {
      const rolling = rollingMean(entry.points, rollingWindow(entry.points.length));
      entry.points.forEach((point, i) => { rows[index.get(point.date)!].rolling = rolling[i]; });
    }
  }
  return rows;
}
