import { describe, expect, it } from "vitest";
import {
  buildAgentFindings,
  buildDimensionFindings,
  diagnosticFingerprint,
  MIN_PREDICTIVE_DATES,
  type DiagnosticObservation,
} from "@/lib/learning/dimension-diagnostics";

function observation(id: number, date: string, available = true): DiagnosticObservation {
  return {
    id, ts: `${date}T21:00:00.000Z`, symbol: `S${id}`, codeVersion: "test-code", analystScore: 50 + id,
    scores: { fundamental: 45 + id, technical: 50 + id, sentiment: 55, macro: 50, insider: 50 },
    availabilityMask: { fundamental: available, technical: available, sentiment: false, macro: available, insider: available },
    benchmarkNeutralReturn: id % 2 ? 0.02 : -0.01, entryEligible: id % 2 === 0,
    direction: id % 2 === 0 ? "long" : "neutral",
    action: id % 2 === 0 ? "signal_written" : "scored", agentLabel: "research",
  };
}

describe("dimension diagnostics P0", () => {
  it("keeps availability and predictive findings separate", () => {
    const rows = [observation(1, "2026-08-01"), observation(2, "2026-08-01")];
    const findings = buildDimensionFindings(rows, 2);
    expect(findings.find((finding) => finding.subjectKey === "sentiment" && finding.findingType === "availability")?.classification).toBe("data_degraded");
    expect(findings.find((finding) => finding.subjectKey === "fundamental" && finding.findingType === "predictive")?.classification).toBe("insufficient_evidence");
  });

  it("refuses a predictive verdict before the predeclared session floor", () => {
    const rows = Array.from({ length: MIN_PREDICTIVE_DATES - 1 }, (_, index) => [
      observation(index * 10 + 1, `2026-07-${String(index + 1).padStart(2, "0")}`),
      observation(index * 10 + 2, `2026-07-${String(index + 1).padStart(2, "0")}`),
      observation(index * 10 + 3, `2026-07-${String(index + 1).padStart(2, "0")}`),
      observation(index * 10 + 4, `2026-07-${String(index + 1).padStart(2, "0")}`),
      observation(index * 10 + 5, `2026-07-${String(index + 1).padStart(2, "0")}`),
    ]).flat();
    const finding = buildDimensionFindings(rows, 2).find((item) => item.subjectKey === "technical" && item.findingType === "predictive");
    expect(finding?.classification).toBe("insufficient_evidence");
  });

  it("records collaboration as unattributable and fingerprints deterministic input", () => {
    const rows = [observation(1, "2026-08-01")];
    expect(buildAgentFindings(rows, 2).find((finding) => finding.subjectType === "collaboration")?.classification).toBe("unattributable_no_paired_shadow");
    expect(diagnosticFingerprint("us", 5, rows)).toBe(diagnosticFingerprint("us", 5, [...rows]));
  });

  // THE REGRESSION THIS FILE EXISTS FOR (2026-08-28).
  //
  // The eligible-long rows rank PERFECTLY BACKWARDS and the ineligible rows rank
  // perfectly forwards. Computing the headline on the all-scored population --
  // which is what shipped for weeks -- yields a positive IC on a score that is
  // in fact anti-predictive where it matters. The sign is the detector: this
  // test cannot pass on the wrong cohort.
  it("computes the predictive headline on the eligible-long cohort, not all scored names", () => {
    const rows: DiagnosticObservation[] = [];
    for (let d = 0; d < 6; d++) {
      const date = `2026-08-${String(d + 1).padStart(2, "0")}`;
      // 5 eligible longs: higher fundamental score -> WORSE return.
      for (let i = 0; i < 5; i++) rows.push({
        id: d * 100 + i, ts: `${date}T13:00:00.000Z`, symbol: `E${i}`, codeVersion: "test-code",
        analystScore: 50 + i,
        scores: { fundamental: 50 + i, technical: 50, sentiment: 50, macro: 50, insider: 50 },
        availabilityMask: { fundamental: true, technical: true, sentiment: true, macro: true, insider: true },
        benchmarkNeutralReturn: -i, entryEligible: true, direction: "long",
        action: "signal_written", agentLabel: "research",
      });
      // 5 ineligible names: higher score -> better return, and a wider spread,
      // so the pooled all-scored IC is strongly positive.
      for (let i = 0; i < 5; i++) rows.push({
        id: d * 100 + 50 + i, ts: `${date}T13:00:00.000Z`, symbol: `N${i}`, codeVersion: "test-code",
        analystScore: 70 + i,
        scores: { fundamental: 70 + i, technical: 50, sentiment: 50, macro: 50, insider: 50 },
        availabilityMask: { fundamental: true, technical: true, sentiment: true, macro: true, insider: true },
        benchmarkNeutralReturn: 10 + i, entryEligible: false, direction: "neutral",
        action: "scored", agentLabel: "research",
      });
    }

    const finding = buildDimensionFindings(rows, 2)
      .find((f) => f.subjectKey === "fundamental" && f.findingType === "predictive");
    expect(finding?.metrics.cohort).toBe("eligible_long");
    expect(finding?.metrics.mean_session_rank_ic).toBeCloseTo(-1, 6);

    const context = finding?.metrics.all_scored_context as Record<string, unknown>;
    expect(context.cohort).toBe("all_scored");
    expect(context.mean_session_rank_ic as number).toBeGreaterThan(0);
  });

  it("grades the agent contribution on the eligible cohort too", () => {
    const rows: DiagnosticObservation[] = [];
    for (let d = 0; d < 6; d++) {
      const date = `2026-08-${String(d + 1).padStart(2, "0")}`;
      for (let i = 0; i < 5; i++) rows.push({
        id: d * 100 + i, ts: `${date}T13:00:00.000Z`, symbol: `E${i}`, codeVersion: "test-code",
        analystScore: 50 + i,
        scores: { fundamental: 50, technical: 50, sentiment: 50, macro: 50, insider: 50 },
        availabilityMask: { fundamental: true, technical: true, sentiment: true, macro: true, insider: true },
        benchmarkNeutralReturn: -i, entryEligible: true, direction: "long",
        action: "signal_written", agentLabel: "research",
      });
      for (let i = 0; i < 5; i++) rows.push({
        id: d * 100 + 50 + i, ts: `${date}T13:00:00.000Z`, symbol: `N${i}`, codeVersion: "test-code",
        analystScore: 70 + i,
        scores: { fundamental: 50, technical: 50, sentiment: 50, macro: 50, insider: 50 },
        availabilityMask: { fundamental: true, technical: true, sentiment: true, macro: true, insider: true },
        benchmarkNeutralReturn: 10 + i, entryEligible: false, direction: "neutral",
        action: "scored", agentLabel: "research",
      });
    }
    const finding = buildAgentFindings(rows, 2).find((f) => f.subjectType === "agent");
    expect(finding?.metrics.cohort).toBe("eligible_long");
    expect(finding?.metrics.mean_session_rank_ic).toBeCloseTo(-1, 6);
    expect(finding?.metrics.eligible_observations).toBe(30);
    expect(finding?.metrics.observations).toBe(60);
  });

  // entry_eligible=true implies direction='long' in production today. If that
  // invariant ever breaks, the cohort must not silently widen.
  it("excludes an eligible row whose direction is not long", () => {
    const rows: DiagnosticObservation[] = [];
    for (let i = 0; i < 5; i++) rows.push({
      id: i, ts: "2026-08-01T13:00:00.000Z", symbol: `S${i}`, codeVersion: "test-code",
      analystScore: 50 + i,
      scores: { fundamental: 50 + i, technical: 50, sentiment: 50, macro: 50, insider: 50 },
      availabilityMask: { fundamental: true, technical: true, sentiment: true, macro: true, insider: true },
      benchmarkNeutralReturn: i, entryEligible: true, direction: "short",
      action: "scored", agentLabel: "research",
    });
    const finding = buildDimensionFindings(rows, 2)
      .find((f) => f.subjectKey === "fundamental" && f.findingType === "predictive");
    expect(finding?.metrics.labeled_observations).toBe(0);
  });

  it("refuses an agent contribution verdict when code-version provenance is missing", () => {
    const row = observation(1, "2026-08-01");
    row.codeVersion = null;
    const finding = buildAgentFindings([row], 2).find((item) => item.subjectType === "agent");
    expect(finding?.classification).toBe("data_degraded");
    expect(finding?.metrics.code_version_coverage).toBe(0);
  });
});
