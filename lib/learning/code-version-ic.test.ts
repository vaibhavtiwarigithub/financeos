import { describe, expect, it } from "vitest";
import { buildCodeVersionIcLedger, applyMultipleComparisonsControl, UNKNOWN_CODE_VERSION } from "./code-version-ic";
import { detectRegressions } from "./ic-regression-alert";
import type { DiagnosticObservation } from "./dimension-diagnostics";

// Same fixture shape as dimension-diagnostics.test.ts: `dates` decision dates,
// each a full cross-section, correlated between fundamental score and outcome
// (or inversely, for the "IC dropped" fixture) so the overlap-corrected floor
// is what decides the classification, not a thin cross-section.
function observations(dates: number, codeVersion: string, opts: { invert?: boolean; startDay?: number } = {}): DiagnosticObservation[] {
  const rows: DiagnosticObservation[] = [];
  const startDay = opts.startDay ?? 0;
  for (let d = 0; d < dates; d++) {
    const day = startDay + d;
    const ts = `2026-0${1 + Math.floor(day / 28)}-${String((day % 28) + 1).padStart(2, "0")}T13:00:00Z`;
    for (let i = 0; i < 6; i++) {
      // Deterministic day-to-day jitter, not a constant per-day ordering:
      // a perfectly constant IC every session gives SD=0, which is a real but
      // degenerate case (tStatistic/CI are correctly null there by design —
      // see dimension-diagnostics.ts). The jitter keeps the fixture realistic
      // (net positive/inverted signal, non-zero session-to-session spread)
      // without being a special case the floor logic has to special-case.
      const jitter = (((day * 31 + i * 7) % 5) - 2) * 0.006;
      const outcome = (opts.invert ? -i * 0.01 : i * 0.01) + jitter;
      rows.push({
        id: day * 100 + i, ts, symbol: `S${i}`, codeVersion,
        analystScore: 50 + i,
        scores: { fundamental: 50 + i * 5, technical: null, sentiment: null, macro: null, insider: null },
        availabilityMask: { fundamental: true },
        benchmarkNeutralReturn: outcome,
        entryEligible: true, direction: "long", action: "scored", agentLabel: "",
      });
    }
  }
  return rows;
}

describe("buildCodeVersionIcLedger", () => {
  it("groups by code_version and reuses buildDimensionFindings' overlap-corrected classification", () => {
    // 20 dates clears MIN_PREDICTIVE_DATES; at horizonDays=10 nEff=2.0, below
    // MIN_EFFECTIVE_OBSERVATIONS(12) -> insufficient_evidence is EXPECTED here.
    const rows = observations(20, "v1");
    const cells = buildCodeVersionIcLedger("us", 10, rows);
    const fundamental = cells.find((c) => c.dimension === "fundamental" && c.codeVersion === "v1");
    expect(fundamental).toBeDefined();
    expect(fundamental!.classification).toBe("insufficient_evidence");
    expect(fundamental!.ci95).toBeNull();
  });

  it("clears the floor and reports a positive IC + CI once nEff clears MIN_EFFECTIVE_OBSERVATIONS", () => {
    // horizonDays=2 -> nEff = sessions/2; 30 dates -> nEff=15, clears both floors.
    const rows = observations(30, "v1");
    const cells = buildCodeVersionIcLedger("us", 2, rows);
    const fundamental = cells.find((c) => c.dimension === "fundamental" && c.codeVersion === "v1");
    expect(fundamental!.classification).toBe("measured_descriptive");
    expect(fundamental!.meanIc).toBeGreaterThan(0.8); // strongly monotone fixture, with jitter
    expect(fundamental!.n).toBeGreaterThan(0);
    expect(fundamental!.ci95).not.toBeNull();
    expect(fundamental!.pValue).not.toBeNull();
  });

  it("buckets rows with no code_version under UNKNOWN_CODE_VERSION rather than dropping or merging them into a named version", () => {
    const rows: DiagnosticObservation[] = observations(30, "v1").map((r) => ({ ...r, codeVersion: null }));
    const cells = buildCodeVersionIcLedger("us", 2, rows);
    expect(cells.every((c) => c.codeVersion === UNKNOWN_CODE_VERSION)).toBe(true);
  });

  it("never emits a numeric verdict for a low-n cell: below-floor cells carry no ci95 or pValue", () => {
    const rows = observations(3, "v1"); // 3 dates: far below MIN_PREDICTIVE_DATES(20)
    const cells = buildCodeVersionIcLedger("us", 10, rows);
    const fundamental = cells.find((c) => c.dimension === "fundamental");
    expect(fundamental!.classification).toBe("insufficient_evidence");
    expect(fundamental!.ci95).toBeNull();
    expect(fundamental!.pValue).toBeNull();
  });
});

describe("applyMultipleComparisonsControl", () => {
  it("flags fewer or equal significant cells than an uncontrolled p<0.05 count (BH is conservative relative to uncontrolled)", () => {
    // Many well-powered versions, all genuinely correlated -> all should have
    // small p-values; BH must not manufacture significance beyond what raw
    // p-values already support.
    const rows = [
      ...observations(30, "v1"),
      ...observations(30, "v2", { startDay: 40 }),
      ...observations(30, "v3", { startDay: 80 }),
    ];
    const cells = buildCodeVersionIcLedger("us", 2, rows);
    const controlled = applyMultipleComparisonsControl(cells);
    const measured = controlled.filter((c) => c.classification === "measured_descriptive");
    const rawSignificant = measured.filter((c) => (c.pValue ?? 1) < 0.05).length;
    const bhSignificant = measured.filter((c) => c.bhSignificant).length;
    expect(bhSignificant).toBeLessThanOrEqual(rawSignificant);
  });

  it("never assigns bhSignificant to an insufficient_evidence cell", () => {
    const rows = [...observations(3, "v1"), ...observations(30, "v2", { startDay: 40 })];
    const cells = buildCodeVersionIcLedger("us", 10, rows);
    const controlled = applyMultipleComparisonsControl(cells);
    for (const cell of controlled) {
      if (cell.classification === "insufficient_evidence") {
        expect(cell.bhSignificant).toBeUndefined();
      }
    }
  });
});

describe("detectRegressions", () => {
  it("does not fire with fewer than the minimum prior measured versions (cannot estimate historical variance from too few points)", () => {
    const rows = [
      ...observations(30, "v1"),
      ...observations(30, "v2", { invert: true, startDay: 40 }), // IC flips sign
    ];
    const cells = buildCodeVersionIcLedger("us", 2, rows);
    expect(detectRegressions(cells)).toHaveLength(0);
  });

  it("fires when the latest version's IC drops multiple historical SDs below a stable prior baseline", () => {
    const versions = ["v1", "v2", "v3", "v4", "v5"].map((v, i) => observations(30, v, { startDay: i * 40 }));
    const latest = observations(30, "v6", { invert: true, startDay: 5 * 40 }); // sign flip after 5 stable versions
    const cells = buildCodeVersionIcLedger("us", 2, [...versions.flat(), ...latest]);
    const alerts = detectRegressions(cells);
    const fundamental = alerts.find((a) => a.dimension === "fundamental");
    expect(fundamental).toBeDefined();
    expect(fundamental!.boundaryCodeVersion).toBe("v6");
    expect(fundamental!.deltaInSd).toBeGreaterThanOrEqual(2);
  });

  it("never anchors a boundary on the unknown-code_version bucket", () => {
    const rows: DiagnosticObservation[] = observations(30, "v1").map((r) => ({ ...r, codeVersion: null }));
    const cells = buildCodeVersionIcLedger("us", 2, rows);
    expect(detectRegressions(cells)).toHaveLength(0);
  });
});
