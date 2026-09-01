import { describe, it, expect } from "vitest";
import {
  runStopShadow, sidakAlpha, criticalT, TRIALS_CONSIDERED,
  BASELINE_STOP_GEOMETRY, CANDIDATE_STOP_GEOMETRY,
  type StopShadowPoint,
} from "@/lib/trading/exit-stop-shadow";
import { resolveLevels, classifyExit } from "@/lib/trading/exit-geometry-shadow";
import { MIN_EFFECTIVE_OBSERVATIONS } from "@/lib/learning/dimension-diagnostics";

const pt = (over: Partial<StopShadowPoint> = {}): StopShadowPoint => ({
  date: "2026-07-01", symbol: "AAA", mfe: 0.01, mae: -0.01, fwd: 0.005, atrPct: 0.02, ...over,
});

describe("geometry: mixed sides", () => {
  // The whole design depends on pairing an ATR stop with the LIVE fixed target.
  // If the geometry type collapses back to "both sides same unit", the candidate
  // silently changes the target too and the comparison stops being attributable.
  it("resolves an ATR stop against a percentage target", () => {
    const levels = resolveLevels(pt({ atrPct: 0.02 }), CANDIDATE_STOP_GEOMETRY);
    expect(levels).not.toBeNull();
    expect(levels!.stopPct).toBeCloseTo(2.8 * 0.02, 10);
    expect(levels!.targetPct).toBeCloseTo(0.192, 10);
  });

  it("keeps the target identical across both arms", () => {
    const b = resolveLevels(pt(), BASELINE_STOP_GEOMETRY)!;
    const c = resolveLevels(pt(), CANDIDATE_STOP_GEOMETRY)!;
    expect(c.targetPct).toBeCloseTo(b.targetPct, 10);
    expect(c.stopPct).not.toBeCloseTo(b.stopPct, 6);
  });

  it("refuses an ATR side with no recorded ATR rather than falling back", () => {
    expect(resolveLevels(pt({ atrPct: 0 }), CANDIDATE_STOP_GEOMETRY)).toBeNull();
    expect(classifyExit(pt({ atrPct: 0 }), CANDIDATE_STOP_GEOMETRY).outcome).toBe("ambiguous");
  });

  it("refuses a side given both units", () => {
    expect(resolveLevels(pt(), { stopPct: 0.05, stopAtr: 2, targetPct: 0.1 })).toBeNull();
  });
});

describe("runStopShadow pairing", () => {
  // THE GUARD THIS EXISTS FOR: if one arm keeps a decision the other cannot
  // classify, the two arms are measured on different cohorts and the difference
  // is not attributable. The pair must be dropped, not the arm.
  it("drops the PAIR when only the candidate is unresolvable", () => {
    const r = runStopShadow("us", 10, [
      pt({ atrPct: 0 }),                       // candidate undefined -> pair dropped
      pt({ date: "2026-07-02", atrPct: 0.02 }),
    ]);
    expect(r.pairsDropped).toBe(1);
    expect(r.nRows).toBe(1);
    expect(r.nDates).toBe(1);
  });

  it("counts one observation per DATE, not per row", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      pt({ date: "2026-07-01", symbol: `S${i}` }));
    const r = runStopShadow("us", 10, many);
    expect(r.nRows).toBe(20);
    expect(r.nDates).toBe(1);
    expect(r.nSymbols).toBe(20);
  });

  // A wider stop should stop out LESS often. This is the mechanism H1 claims.
  it("shows the ATR stop firing less often when it is wider", () => {
    // mae -6%: breaches the 7.5%? no. Use -8%: baseline stop (7.5%) fires,
    // candidate stop (2.8 * 0.05 = 14%) does not.
    const pts = Array.from({ length: 5 }, (_, i) =>
      pt({ date: `2026-07-0${i + 1}`, mae: -0.08, mfe: 0.02, fwd: 0.01, atrPct: 0.05 }));
    const r = runStopShadow("us", 10, pts);
    expect(r.baselineStops).toBe(5);
    expect(r.candidateStops).toBe(0);
    expect(r.candidateTimeouts).toBe(5);
    expect(r.meanPairedDiff!).toBeGreaterThan(0);
  });

  it("reports the worst single outcome, not just the mean", () => {
    const r = runStopShadow("us", 10, [
      pt({ date: "d1", mae: -0.50, mfe: 0.01, fwd: -0.4, atrPct: 0.30 }), // huge ATR stop
      pt({ date: "d2", mae: -0.01, mfe: 0.01, fwd: 0.02, atrPct: 0.02 }),
    ]);
    // A wider stop can lift the mean while worsening the tail; both are recorded.
    expect(r.candidateWorstReturn).not.toBeNull();
    expect(r.baselineWorstReturn).not.toBeNull();
    expect(r.candidateWorstReturn!).toBeLessThan(0);
  });

  it("refuses a verdict below the overlap-adjusted floor", () => {
    const pts = Array.from({ length: 30 }, (_, i) =>
      pt({ date: `2026-07-${String(i + 1).padStart(2, "0")}` }));
    const r = runStopShadow("us", 10, pts);
    // 30 dates at h10 = 3.0 effective observations, below the floor of 12.
    expect(r.effectiveObservations).toBeCloseTo(3, 6);
    expect(r.status).toBe("insufficient_evidence");
    expect(r.reason).toContain("independent observations");
  });

  it("reaches measured only when the overlap floor is cleared", () => {
    const pts = Array.from({ length: 130 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      return pt({ date: day, mae: -0.02 - (i % 5) * 0.01, fwd: 0.01 });
    });
    const r = runStopShadow("us", 10, pts);
    expect(r.effectiveObservations).toBeGreaterThanOrEqual(MIN_EFFECTIVE_OBSERVATIONS);
    expect(r.status).toBe("measured");
  });
});

describe("multiplicity control", () => {
  // H1 won a 14-arm search. Reporting it against a nominal 0.05 would overstate
  // it by roughly an order of magnitude.
  it("Sidak-adjusts for the grid the hypothesis was selected from", () => {
    const a = sidakAlpha(TRIALS_CONSIDERED);
    expect(TRIALS_CONSIDERED).toBe(14);
    expect(a).toBeCloseTo(1 - Math.pow(0.95, 1 / 14), 12);
    expect(a).toBeLessThan(0.05);
    expect(a).toBeCloseTo(0.003657, 5);
  });

  it("demands a materially larger |t| than the nominal 1.96", () => {
    expect(criticalT(0.05)).toBeCloseTo(1.96, 2);
    expect(criticalT(sidakAlpha(14))).toBeGreaterThan(2.9);
  });

  it("carries the adjusted alpha on every result", () => {
    const r = runStopShadow("us", 10, [pt()]);
    expect(r.trialsConsidered).toBe(14);
    expect(r.sidakAlpha).toBeCloseTo(1 - Math.pow(0.95, 1 / 14), 12);
  });
});
