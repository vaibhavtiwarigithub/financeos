import { describe, expect, it } from "vitest";
import {
  buildAgentFindings,
  buildDimensionFindings,
  diagnosticFingerprint,
  MIN_PREDICTIVE_DATES,
  type DiagnosticObservation,
} from "@/lib/learning/dimension-diagnostics";
import { readFileSync } from "node:fs";

function observation(id: number, date: string, available = true): DiagnosticObservation {
  return {
    id, ts: `${date}T21:00:00.000Z`, symbol: `S${id}`, codeVersion: "test-code", analystScore: 50 + id,
    scores: { fundamental: 45 + id, technical: 50 + id, sentiment: 55, macro: 50, insider: 50 },
    availabilityMask: { fundamental: available, technical: available, sentiment: false, macro: available, insider: available },
    benchmarkNeutralReturn: id % 2 ? 0.02 : -0.01, entryEligible: id % 2 === 0,
    decisionContext: id % 2 === 0 ? "entry_candidate" : "holding_review",
    direction: id % 2 === 0 ? "long" : "neutral",
    action: id % 2 === 0 ? "signal_written" : "scored", agentLabel: "research",
    sessionValidated: true, asOfSession: date,
  };
}

describe("dimension diagnostics P0", () => {
  it("does not present shared macro as a zero stock-rank IC", () => {
    const panel = readFileSync("components/dashboard/DimensionIcPanel.tsx", "utf8");
    expect(panel).not.toContain("IC is 0 BY CONSTRUCTION");
    expect(panel).toContain("dated macro outcome panel rather than displayed as a zero IC");
  });

  it("does not call immature empty horizons a provider failure",()=>{
    const empty=buildDimensionFindings([],120).filter(f=>f.findingType==="availability");
    expect(empty).toHaveLength(5);
    expect(empty.every(f=>f.classification==="insufficient_evidence"&&f.metrics.availability_rate===null)).toBe(true);
    const populated=buildDimensionFindings([observation(1,"2026-08-01",false)],2);
    expect(populated.find(f=>f.subjectKey==="technical"&&f.findingType==="availability")?.classification).toBe("data_degraded");
  });
  it("distinguishes intentionally disabled dimensions from missing data", () => {
    const rows = Array.from({ length: 6 }, (_, id) => ({
      ...observation(id, "2026-08-01"),
      availabilityMask: { fundamental: true, technical: true, sentiment: false, macro: false, insider: false },
      dimensionApplicability: {
        sentiment: { state: "not_enabled" as const, reason: "No validated India sentiment score is active." },
        macro: { state: "not_enabled" as const, reason: "US-only macro score." },
        insider: { state: "not_enabled" as const, reason: "India insider source did not qualify." },
      },
    }));
    const findings = buildDimensionFindings(rows, 2);
    for (const key of ["sentiment", "macro", "insider"]) {
      expect(findings.find((f) => f.subjectKey === key && f.findingType === "availability")?.classification).toBe("not_enabled");
      expect(findings.find((f) => f.subjectKey === key && f.findingType === "predictive")?.classification).toBe("not_enabled");
    }
  });

  it("does not call a shared market-wide macro scalar a cross-sectional rank signal", () => {
    const rows = Array.from({ length: 6 }, (_, id) => ({
      ...observation(id, "2026-08-01"),
      scores: { ...observation(id, "2026-08-01").scores, macro: 63 },
      availabilityMask: { fundamental: true, technical: true, sentiment: true, macro: true, insider: true },
      dimensionApplicability: { macro: { state: "applicable" as const } },
    }));
    const finding = buildDimensionFindings(rows, 2).find((f) => f.subjectKey === "macro" && f.findingType === "predictive");
    expect(finding?.classification).toBe("not_rankable");
    expect(finding?.metrics.mean_session_rank_ic).toBeUndefined();
    expect(finding?.metrics.t_stat).toBeNull();
    expect(finding?.reason).toContain("market-context forward-outcome panel");
  });

  it("counts availability over applicable rows, excluding structural exclusions", () => {
    const rows = [
      { ...observation(1, "2026-08-01"), dimensionApplicability: { sentiment: { state: "not_enabled" as const } } },
      { ...observation(2, "2026-08-01"), dimensionApplicability: { sentiment: { state: "applicable" as const } }, availabilityMask: { sentiment: true } },
      { ...observation(3, "2026-08-01"), dimensionApplicability: { sentiment: { state: "applicable" as const } }, availabilityMask: { sentiment: false } },
    ];
    const availability = buildDimensionFindings(rows, 2).find(f => f.subjectKey === "sentiment" && f.findingType === "availability");
    expect(availability?.metrics.applicable).toBe(2);
    expect(availability?.metrics.not_enabled).toBe(1);
    expect(availability?.metrics.available).toBe(1);
    expect(availability?.metrics.availability_rate).toBe(0.5);
  });
  it("does not count intentionally excluded dimensions as agent data outages", () => {
    const row = {
      ...observation(1, "2026-08-01"),
      availabilityMask: { fundamental: true, technical: true, sentiment: false, macro: false, insider: false },
      dimensionApplicability: {
        sentiment: { state: "not_enabled" as const },
        macro: { state: "not_enabled" as const },
        insider: { state: "not_applicable" as const },
      },
    };
    const finding = buildAgentFindings([row], 2).find((item) => item.subjectType === "agent");
    expect(finding?.metrics.dimension_availability_rate).toBe(1);
    expect(finding?.metrics.dimension_availability_known_applicable_inputs).toBe(2);
    expect(finding?.metrics.dimensions_not_enabled).toBe(2);
    expect(finding?.metrics.dimensions_not_applicable).toBe(1);
  });
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

  it("keeps invalid weekend research visible for data quality but out of predictive IC", () => {
    const valid = Array.from({ length: 6 }, (_, i) => observation(i * 2 + 2, "2026-08-07"));
    const weekend = Array.from({ length: 6 }, (_, i) => ({
      ...observation(i * 2 + 102, "2026-08-08"),
      sessionValidated: false, asOfSession: "2026-08-07",
    }));
    const rows = [...valid, ...weekend];
    const findings = buildDimensionFindings(rows, 2);
    const availability = findings.find(f => f.subjectKey === "technical" && f.findingType === "availability")!;
    const predictive = findings.find(f => f.subjectKey === "technical" && f.findingType === "predictive")!;
    expect(availability.metrics.invalid_or_unknown_session_provenance).toBe(6);
    expect(predictive.metrics.distinct_sessions).toBe(1);
    expect((predictive.metrics.session_ic_series as any[]).every(point => point.date !== "2026-08-08")).toBe(true);
    expect(diagnosticFingerprint("us", 2, rows)).not.toBe(diagnosticFingerprint("us", 2,
      rows.map(row => ({ ...row, sessionValidated: true }))));
  });

  it("does not turn missing factor scores or forward outcomes into zero-return evidence", () => {
    const rows = [
      { ...observation(2, "2026-08-07"), scores: { ...observation(2, "2026-08-07").scores, fundamental: null } },
      { ...observation(4, "2026-08-07"), benchmarkNeutralReturn: null },
    ];
    const predictive = buildDimensionFindings(rows, 2)
      .find(f => f.subjectKey === "fundamental" && f.findingType === "predictive")!;
    expect(predictive.metrics.labeled_observations).toBe(0);
    expect(predictive.classification).toBe("insufficient_evidence");
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
        benchmarkNeutralReturn: -i, entryEligible: true, direction: "long", decisionContext: "entry_candidate",
        action: "signal_written", agentLabel: "research", sessionValidated: true, asOfSession: date,
      });
      // 5 ineligible names: higher score -> better return, and a wider spread,
      // so the pooled all-scored IC is strongly positive.
      for (let i = 0; i < 5; i++) rows.push({
        id: d * 100 + 50 + i, ts: `${date}T13:00:00.000Z`, symbol: `N${i}`, codeVersion: "test-code",
        analystScore: 70 + i,
        scores: { fundamental: 70 + i, technical: 50, sentiment: 50, macro: 50, insider: 50 },
        availabilityMask: { fundamental: true, technical: true, sentiment: true, macro: true, insider: true },
        benchmarkNeutralReturn: 10 + i, entryEligible: false, direction: "neutral", decisionContext: "holding_review",
        action: "scored", agentLabel: "research", sessionValidated: true, asOfSession: date,
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
        benchmarkNeutralReturn: -i, entryEligible: true, direction: "long", decisionContext: "entry_candidate",
        action: "signal_written", agentLabel: "research", sessionValidated: true, asOfSession: date,
      });
      for (let i = 0; i < 5; i++) rows.push({
        id: d * 100 + 50 + i, ts: `${date}T13:00:00.000Z`, symbol: `N${i}`, codeVersion: "test-code",
        analystScore: 70 + i,
        scores: { fundamental: 50, technical: 50, sentiment: 50, macro: 50, insider: 50 },
        availabilityMask: { fundamental: true, technical: true, sentiment: true, macro: true, insider: true },
        benchmarkNeutralReturn: 10 + i, entryEligible: false, direction: "neutral", decisionContext: "holding_review",
        action: "scored", agentLabel: "research", sessionValidated: true, asOfSession: date,
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
      action: "scored", agentLabel: "research", sessionValidated: true, asOfSession: "2026-08-01",
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
