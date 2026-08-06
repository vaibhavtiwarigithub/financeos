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
    action: id % 2 === 0 ? "signal_written" : "scored", agentLabel: "research",
  };
}

describe("dimension diagnostics P0", () => {
  it("keeps availability and predictive findings separate", () => {
    const rows = [observation(1, "2026-08-01"), observation(2, "2026-08-01")];
    const findings = buildDimensionFindings(rows);
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
    const finding = buildDimensionFindings(rows).find((item) => item.subjectKey === "technical" && item.findingType === "predictive");
    expect(finding?.classification).toBe("insufficient_evidence");
  });

  it("records collaboration as unattributable and fingerprints deterministic input", () => {
    const rows = [observation(1, "2026-08-01")];
    expect(buildAgentFindings(rows).find((finding) => finding.subjectType === "collaboration")?.classification).toBe("unattributable_no_paired_shadow");
    expect(diagnosticFingerprint("us", 5, rows)).toBe(diagnosticFingerprint("us", 5, [...rows]));
  });

  it("refuses an agent contribution verdict when code-version provenance is missing", () => {
    const row = observation(1, "2026-08-01");
    row.codeVersion = null;
    const finding = buildAgentFindings([row]).find((item) => item.subjectType === "agent");
    expect(finding?.classification).toBe("data_degraded");
    expect(finding?.metrics.code_version_coverage).toBe(0);
  });
});
