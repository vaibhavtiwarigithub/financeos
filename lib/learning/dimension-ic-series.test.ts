import { describe, expect, it } from "vitest";
import {
  buildDimensionFindings,
  tStatistic,
  MIN_CROSS_SECTION,
  type DiagnosticObservation,
} from "./dimension-diagnostics";

// Covers the per-session IC series and the t-statistic added so the Learning
// page can render a table and an honest chart.
//
// WHY THE SERIES EXISTS. `mean_session_rank_ic` is an EXPANDING-window average
// over every session to date. Plotting it across daily diagnostic runs charts a
// cumulative mean converging, not a signal changing: consecutive runs share
// ~93% of their input sessions. Measured in production, technical's stored run
// history read +0.1394 frozen for nine days, then oscillated (qualifying
// sessions 17 -> 15 -> 17 -> 14) because the loader was truncated at
// PostgREST's 1,000-row cap, then settled at -0.13. Drawn as a line that reads
// as "technical decayed through August"; it was two bug fixes landing on
// 2026-08-28. The per-session points are one trading day each and are the only
// thing here that may be charted as a time series.

function rowsFor(perDateOutcomes: Array<{ date: string; scores: number[]; outcomes: number[] }>): DiagnosticObservation[] {
  const rows: DiagnosticObservation[] = [];
  let id = 0;
  for (const entry of perDateOutcomes) {
    for (let i = 0; i < entry.scores.length; i++) {
      rows.push({
        id: id++,
        ts: `${entry.date}T13:00:00Z`,
        symbol: `S${i}`,
        codeVersion: "test",
        analystScore: 70,
        scores: { fundamental: entry.scores[i], technical: null, sentiment: null, macro: null, insider: null },
        availabilityMask: { fundamental: true },
        benchmarkNeutralReturn: entry.outcomes[i],
        entryEligible: true,
        direction: "long",
        action: "scored",
        agentLabel: "research",
      });
    }
  }
  return rows;
}

function predictiveMetricsFor(rows: DiagnosticObservation[], horizon = 5) {
  const finding = buildDimensionFindings(rows, horizon)
    .find((f) => f.subjectKey === "fundamental" && f.findingType === "predictive")!;
  return finding.metrics as Record<string, any>;
}

describe("per-session IC series", () => {
  it("emits one point per qualifying session, chronologically", () => {
    // Rows are supplied newest-date-first on purpose: the loader pages by id,
    // not by calendar, so an unsorted series would plot backwards.
    const metrics = predictiveMetricsFor(rowsFor([
      { date: "2026-03-03", scores: [1, 2, 3, 4, 5], outcomes: [5, 4, 3, 2, 1] },
      { date: "2026-03-01", scores: [1, 2, 3, 4, 5], outcomes: [1, 2, 3, 4, 5] },
      { date: "2026-03-02", scores: [1, 2, 3, 4, 5], outcomes: [1, 2, 3, 4, 5] },
    ]));
    const series = metrics.session_ic_series as Array<{ date: string; ic: number; cross_section: number }>;
    expect(series.map((s) => s.date)).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
    expect(series).toHaveLength(3);
    // Perfectly aligned days score +1, the reversed day -1.
    expect(series[0].ic).toBeCloseTo(1, 10);
    expect(series[2].ic).toBeCloseTo(-1, 10);
    expect(series[0].cross_section).toBe(5);
  });

  it("drops sessions below the cross-section floor instead of charting them", () => {
    // A 2-name day can produce a rank IC of exactly +/-1 from noise. Plotting
    // it would put the chart's most extreme point on its weakest evidence.
    const thin = MIN_CROSS_SECTION - 1;
    const metrics = predictiveMetricsFor(rowsFor([
      { date: "2026-03-01", scores: Array.from({ length: thin }, (_, i) => i), outcomes: Array.from({ length: thin }, (_, i) => i) },
      { date: "2026-03-02", scores: [1, 2, 3, 4, 5], outcomes: [1, 2, 3, 4, 5] },
    ]));
    const series = metrics.session_ic_series as Array<{ date: string }>;
    expect(series.map((s) => s.date)).toEqual(["2026-03-02"]);
    expect(metrics.qualifying_sessions).toBe(1);
  });

  it("the series mean equals the reported headline mean", () => {
    // The chart and the table must not disagree — they are the same numbers.
    const metrics = predictiveMetricsFor(rowsFor([
      { date: "2026-03-01", scores: [1, 2, 3, 4, 5], outcomes: [1, 2, 3, 4, 5] },
      { date: "2026-03-02", scores: [1, 2, 3, 4, 5], outcomes: [5, 4, 3, 2, 1] },
      { date: "2026-03-03", scores: [1, 2, 3, 4, 5], outcomes: [1, 2, 3, 4, 5] },
    ]));
    const series = metrics.session_ic_series as Array<{ ic: number }>;
    const seriesMean = series.reduce((sum, s) => sum + s.ic, 0) / series.length;
    expect(metrics.mean_session_rank_ic).toBeCloseTo(seriesMean, 12);
  });

  it("carries no series on the all-scored context cohort", () => {
    // Context may never be cited as predictive power, so it gets no line to plot.
    const metrics = predictiveMetricsFor(rowsFor([
      { date: "2026-03-01", scores: [1, 2, 3, 4, 5], outcomes: [1, 2, 3, 4, 5] },
    ]));
    expect(metrics.session_ic_series).toBeDefined();
    expect(metrics.all_scored_context.session_ic_series).toBeUndefined();
  });
});

describe("t statistic", () => {
  it("divides by sqrt(nEffective), not sqrt(sessions)", () => {
    // THE DEFECT THIS PREVENTS. Overlapping windows mean N sessions are not N
    // draws. Using sqrt(sessions) overstates |t| by sqrt(horizonDays) — at h20
    // by ~4.5x — which is exactly how an overlapped sample manufactures
    // significance.
    const mean = 0.1;
    const sd = 0.2;
    const sessions = 40;
    const horizon = 20;
    const nEffective = sessions / horizon; // 2.0
    const correct = tStatistic(mean, sd, nEffective);
    const naive = mean / (sd / Math.sqrt(sessions));
    expect(correct).toBeCloseTo(0.1 / (0.2 / Math.sqrt(2)), 12);
    expect(Math.abs(naive / correct!)).toBeCloseTo(Math.sqrt(horizon), 10);
  });

  it("returns null rather than Infinity when spread is degenerate", () => {
    // sd === 0 means every session had an identical IC. Infinity would render
    // as an overwhelmingly decisive result off a sample with no variation.
    expect(tStatistic(0.1, 0, 10)).toBeNull();
    expect(tStatistic(0.1, null, 10)).toBeNull();
    expect(tStatistic(null, 0.2, 10)).toBeNull();
    expect(tStatistic(0.1, 0.2, 0)).toBeNull();
  });

  it("is null for a single session, where spread is undefined", () => {
    const metrics = predictiveMetricsFor(rowsFor([
      { date: "2026-03-01", scores: [1, 2, 3, 4, 5], outcomes: [1, 2, 3, 4, 5] },
    ]));
    expect(metrics.qualifying_sessions).toBe(1);
    expect(metrics.sd_session_rank_ic).toBeNull();
    expect(metrics.t_stat).toBeNull();
  });

  it("agrees with a hand-computed t on a known series", () => {
    const metrics = predictiveMetricsFor(rowsFor([
      { date: "2026-03-01", scores: [1, 2, 3, 4, 5], outcomes: [1, 2, 3, 4, 5] },   // ic +1
      { date: "2026-03-02", scores: [1, 2, 3, 4, 5], outcomes: [5, 4, 3, 2, 1] },   // ic -1
      { date: "2026-03-03", scores: [1, 2, 3, 4, 5], outcomes: [1, 2, 3, 4, 5] },   // ic +1
    ]), 5);
    // mean = 1/3; sample sd of [1,-1,1] = sqrt(4/3); nEff = 3/5
    const expectedSd = Math.sqrt(4 / 3);
    expect(metrics.sd_session_rank_ic).toBeCloseTo(expectedSd, 12);
    expect(metrics.t_stat).toBeCloseTo((1 / 3) / (expectedSd / Math.sqrt(3 / 5)), 10);
  });
});
