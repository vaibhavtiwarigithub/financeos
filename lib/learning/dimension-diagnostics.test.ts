import { describe, expect, it } from "vitest";
import {
  buildDimensionFindings,
  effectiveObservations,
  DIAGNOSTIC_HORIZONS,
  MIN_PREDICTIVE_DATES,
  MIN_EFFECTIVE_OBSERVATIONS,
  type DiagnosticObservation,
} from "./dimension-diagnostics";

// Build `dates` decision dates, each with a full cross-section, so the
// date-count floor (MIN_PREDICTIVE_DATES) is satisfied and the ONLY thing that
// can still refuse a predictive conclusion is the overlap correction.
function observations(dates: number, perDate = 6): DiagnosticObservation[] {
  const rows: DiagnosticObservation[] = [];
  for (let d = 0; d < dates; d++) {
    const ts = `2026-0${1 + Math.floor(d / 28)}-${String((d % 28) + 1).padStart(2, "0")}T13:00:00Z`;
    for (let i = 0; i < perDate; i++) {
      rows.push({
        id: d * 100 + i,
        ts,
        symbol: `S${i}`,
        codeVersion: "test",
        analystScore: 50 + i,
        // Deliberately correlated with the outcome: if the floors were removed
        // this WOULD produce a confident-looking positive IC, which is exactly
        // the false conclusion the correction exists to prevent.
        scores: { fundamental: 50 + i * 5, technical: null, sentiment: null, macro: null, insider: null },
        availabilityMask: { fundamental: true },
        benchmarkNeutralReturn: i * 0.01,
        entryEligible: true,
        direction: "long",
        action: "scored",
        agentLabel: "research",
      });
    }
  }
  return rows;
}

function fundamentalPredictive(rows: DiagnosticObservation[], horizonDays: number) {
  return buildDimensionFindings(rows, horizonDays)
    .find(f => f.subjectKey === "fundamental" && f.findingType === "predictive")!;
}

describe("effectiveObservations", () => {
  it("applies the n / horizonDays overlap correction", () => {
    expect(effectiveObservations(20, 10)).toBeCloseTo(2.0);
    expect(effectiveObservations(20, 20)).toBeCloseTo(1.0);
    expect(effectiveObservations(20, 120)).toBeCloseTo(0.1667, 3);
  });

  it("refuses to divide by a nonsense horizon rather than returning Infinity", () => {
    expect(effectiveObservations(20, 0)).toBe(0);
    expect(effectiveObservations(20, -5)).toBe(0);
    expect(effectiveObservations(20, Number.NaN)).toBe(0);
  });
});

describe("predictive floor is horizon-aware", () => {
  // THE load-bearing case. 20 dates clears MIN_PREDICTIVE_DATES, so a
  // horizon-blind gate would emit a predictive finding here — on 20 windows of
  // 120 days each, which overlap to 0.17 independent observations.
  it("refuses a predictive conclusion at h120 on 20 dates", () => {
    const finding = fundamentalPredictive(observations(20), 120);
    expect(finding.classification).toBe("insufficient_evidence");
    expect(finding.metrics.effective_observations).toBeCloseTo(0.1667, 3);
    expect(finding.reason).toContain("independent observations");
  });

  it("still refuses at h120 even with enough dates to pass the date floor many times over", () => {
    const finding = fundamentalPredictive(observations(56), 120);
    expect(finding.classification).toBe("insufficient_evidence");
  });

  it("allows a descriptive conclusion at h2 where overlap is not binding", () => {
    const rows = observations(MIN_PREDICTIVE_DATES + 5);
    const finding = fundamentalPredictive(rows, 2);
    expect(effectiveObservations(MIN_PREDICTIVE_DATES + 5, 2)).toBeGreaterThanOrEqual(MIN_EFFECTIVE_OBSERVATIONS);
    expect(finding.classification).toBe("measured_descriptive");
  });

  it("still refuses when the date floor fails, regardless of horizon", () => {
    expect(fundamentalPredictive(observations(3), 2).classification).toBe("insufficient_evidence");
  });

  it("reports the horizon it was evaluated at", () => {
    expect(fundamentalPredictive(observations(20), 60).metrics.horizon_days).toBe(60);
  });
});

describe("DIAGNOSTIC_HORIZONS", () => {
  // Must stay in step with HORIZONS in app/api/agents/label-maturation/route.ts
  // and with the dimension_diagnostic_runs horizon_days CHECK constraint
  // (migration 20260824220000) — a horizon here that the constraint rejects
  // makes the insert throw, which kills the run for every other horizon too.
  it("covers the long exit-timing horizons the labeler writes", () => {
    expect([...DIAGNOSTIC_HORIZONS]).toEqual([2, 5, 10, 20, 60, 120]);
  });
});
