// Alpha Diagnostic Lab — A2 entry selection and calibration.
//
// The question this answers is the one everything else depends on: does the
// score RANK forward returns at all? If it does not, no downstream repair to
// sizing, exits or costs can create an edge — it can only stop destroying one.
//
// Measured 2026-08-25 on this book: US composite rank IC +0.051 (t=0.93),
// indistinguishable from luck, while US fundamental alone reached +0.076
// (t=2.40). Both composites ranked WORSE than their own best single dimension.
// A2 exists to keep that measurement running rather than to be re-derived by
// hand each time.
//
// READ-ONLY. Composes the existing Spearman authority rather than adding a
// second implementation of rank correlation.

import { spearman } from "@/lib/learning/archetype-ic";
import { isEligibleLong } from "@/lib/learning/entry-cohort";
import { quintileSpread, type SelectionRow } from "./alpha-diagnostics";
import {
  ALPHA_DIAGNOSTIC_METRIC_VERSION,
  type DiagnosticFinding,
  type DiagnosticMarket,
  type DiagnosticSample,
  sampleStatus,
} from "./alpha-diagnostic-contract";

/**
 * One row per (symbol, date) — earliest of the day.
 *
 * The research cron writes 2-3 observations per symbol per day, so an
 * undeduplicated cross-section gives those symbols 2-3x weight WITHIN a single
 * date. Date-clustering handles independence BETWEEN dates and does nothing
 * about this.
 */
export function dedupeSelectionRows(
  rows: Array<SelectionRow & { ts?: string }>,
): SelectionRow[] {
  const best = new Map<string, SelectionRow & { ts?: string }>();
  for (const r of rows) {
    const key = `${r.symbol}|${r.date}`;
    const prior = best.get(key);
    if (!prior || (r.ts ?? "") < (prior.ts ?? "")) best.set(key, r);
  }
  return [...best.values()].map(({ ts, ...rest }) => rest);
}

/** Build a named selection cohort from persisted observation rows. Filtering
 * happens before symbol/date deduplication, so an earlier ineligible score can
 * never displace the first eligible-long decision. */
export function selectionRowsFromObservations(
  rows: any[],
  horizonDays: number,
  cohort: "eligible_long" | "all_scored",
): Array<SelectionRow & { ts: string }> {
  return rows
    .filter(r => cohort === "all_scored" || isEligibleLong(r.entry_eligible, r.direction))
    .flatMap(r => {
      const labels: any[] = Array.isArray(r.observation_labels) ? r.observation_labels : [r.observation_labels];
      const label = labels.find(l => l && Number(l.horizon_days) === horizonDays);
      if (!label || r.analyst_score == null || r.analyst_score === ""
        || label.benchmark_neutral_return == null || label.benchmark_neutral_return === "") return [];
      const score = Number(r.analyst_score);
      const forwardReturn = Number(label.benchmark_neutral_return);
      if (!Number.isFinite(score) || !Number.isFinite(forwardReturn)) return [];
      return [{
        date: String(r.ts).slice(0, 10),
        symbol: String(r.symbol),
        score,
        forwardReturn,
        ts: String(r.ts),
      }];
    });
}

/** Mean of per-date statistics, with the date-clustered t. */
function clustered(values: number[]): { mean: number | null; t: number | null; n: number } {
  const n = values.length;
  if (n === 0) return { mean: null, t: null, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, t: null, n };
  const varc = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(varc / n);
  return { mean, t: se === 0 ? null : mean / se, n };
}

export interface DailySelectionStatistic {
  mean: number | null;
  t: number | null;
  nDates: number;
  values: Array<{ date: string; value: number }>;
}

/** The exact A2 estimand, reusable by A8 so robustness cannot drift to a
 * different pooled statistic. Input must already be symbol/date deduplicated. */
export function dailyRankIcStatistic(
  rows: SelectionRow[],
  minCrossSection = 5,
): DailySelectionStatistic {
  const byDate = new Map<string, SelectionRow[]>();
  for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const values: Array<{ date: string; value: number }> = [];
  for (const [date, dayRows] of byDate) {
    if (dayRows.length < minCrossSection) continue;
    const ic = spearman(dayRows.map(r => r.score), dayRows.map(r => r.forwardReturn));
    if (ic != null && Number.isFinite(ic)) values.push({ date, value: ic });
  }
  const stat = clustered(values.map(v => v.value));
  return { mean: stat.mean, t: stat.t, nDates: stat.n, values };
}

export function runA2Selection(
  market: DiagnosticMarket,
  rows: Array<SelectionRow & { ts?: string }>,
  horizonDays: number,
  minDates: number,
  minCrossSection = 5,
): DiagnosticFinding {
  const deduped = dedupeSelectionRows(rows);

  const byDate = new Map<string, SelectionRow[]>();
  for (const r of deduped) {
    byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  }

  const sessionSpreads: number[] = [];
  for (const dayRows of byDate.values()) {
    // A cross-section too thin to rank tells us nothing; skipping is honest,
    // scoring it would inject noise dressed as a measurement.
    if (dayRows.length < minCrossSection) continue;
    const q = quintileSpread(dayRows);
    if (q.spread != null && Number.isFinite(q.spread)) sessionSpreads.push(q.spread);
  }

  const exactIc = dailyRankIcStatistic(deduped, minCrossSection);
  const icStat = { mean: exactIc.mean, t: exactIc.t, n: exactIc.nDates };
  const spreadStat = clustered(sessionSpreads);

  const sample: DiagnosticSample = {
    nRows: deduped.length,
    nDates: icStat.n,
    nSymbols: new Set(deduped.map(r => r.symbol)).size,
    horizonDays,
    dateUnit: "decision_date",
  };
  const gate = sampleStatus(sample, minDates);

  // Pooled quintile spread across everything, for scale. Reported SEPARATELY
  // from the per-date mean because pooling mixes dates and is not the
  // clustered statistic — it is context, not evidence.
  const pooled = quintileSpread(deduped);

  return {
    market, testId: "A2", cohort: "learning",
    window: {
      from: deduped.length ? deduped.map(r => r.date).reduce((a, b) => (a < b ? a : b)) : "",
      to: deduped.length ? deduped.map(r => r.date).reduce((a, b) => (a > b ? a : b)) : "",
    },
    sample,
    coverage: rows.length === 0 ? 0 : deduped.length / rows.length,
    metricVersion: ALPHA_DIAGNOSTIC_METRIC_VERSION,
    status: gate.status,
    reason: gate.ok
      ? "Date-clustered rank IC and top-minus-bottom quintile spread. Rank IC says the ordering correlates; the spread says whether acting on it would have paid. A positive IC with a flat spread is not tradeable."
      : gate.reason,
    metrics: {
      horizonDays,
      rankIc: icStat.mean,
      rankIcT: icStat.t,
      qualifyingSessions: icStat.n,
      meanQuintileSpread: spreadStat.mean,
      quintileSpreadT: spreadStat.t,
      pooledQuintileSpread: pooled.spread,
      pooledPerBucket: pooled.perBucket,
      // Monotonic buckets are the shape a usable ranking has. A non-monotonic
      // sequence with a positive top-minus-bottom is a ranking that works only
      // at the extremes.
      pooledMonotonic: isMonotonicIncreasing(pooled.perBucket),
      minCrossSection,
      dedupedFrom: rows.length,
    },
  };
}

function isMonotonicIncreasing(xs: number[]): boolean | null {
  const usable = xs.filter(v => Number.isFinite(v));
  if (usable.length < 2) return null;
  for (let i = 1; i < usable.length; i++) if (usable[i] < usable[i - 1]) return false;
  return true;
}
