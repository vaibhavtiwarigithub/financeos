import { describe, it, expect } from "vitest";
import {
  buildCandidateGeometries,
  classifyExit,
  evaluateGeometry,
  isBaseline,
  MAX_AMBIGUOUS_SHARE,
  type LabelPoint,
} from "@/lib/trading/exit-geometry-shadow";

const ATR = 0.03; // 3% entry ATR, close to the measured US average
const G = { stopAtr: 2, targetAtr: 3 }; // stop -6%, target +9%

function point(mfe: number, mae: number, fwd: number, atrPct = ATR): LabelPoint {
  return { mfe, mae, fwd, atrPct };
}

describe("classifyExit", () => {
  it("books the target when it is reached and the stop never is", () => {
    const c = classifyExit(point(0.10, -0.02, 0.07), G);
    expect(c.outcome).toBe("target");
    expect(c.ret).toBeCloseTo(0.09); // 3 ATR, not the realised fwd
  });

  it("books the stop when it is breached and the target never is", () => {
    const c = classifyExit(point(0.01, -0.08, -0.05), G);
    expect(c.outcome).toBe("stop");
    expect(c.ret).toBeCloseTo(-0.06);
  });

  it("falls through to the time stop when neither level is touched", () => {
    const c = classifyExit(point(0.02, -0.03, 0.011), G);
    expect(c.outcome).toBe("timeout");
    expect(c.ret).toBeCloseTo(0.011);
  });

  it("REFUSES to guess when both levels were touched", () => {
    // MFE +10% clears the +9% target AND MAE -8% breaches the -6% stop. Summary
    // statistics cannot say which came first. Assuming the favourable one is how
    // a backtest manufactures an edge, so this books nothing.
    const c = classifyExit(point(0.10, -0.08, 0.03), G);
    expect(c.outcome).toBe("ambiguous");
    expect(c.ret).toBeNull();
  });

  it("treats the level as touched at exact equality, on both legs", () => {
    expect(classifyExit(point(0.09, -0.01, 0.05), G).outcome).toBe("target");
    expect(classifyExit(point(0.01, -0.06, -0.04), G).outcome).toBe("stop");
  });

  it("is ambiguous rather than wrong on unusable inputs", () => {
    // An ATR geometry on a decision with no recorded ATR is UNDEFINED. It must
    // not silently fall back to a percentage — US 10-day labels have 4.1% ATR
    // coverage, so a silent fallback would quietly change what is being tested.
    expect(classifyExit(point(0.1, -0.01, 0.05, 0), G).outcome).toBe("ambiguous");
    expect(classifyExit(point(NaN, -0.01, 0.05), G).outcome).toBe("ambiguous");
  });

  it("a PERCENTAGE geometry still resolves when ATR is missing", () => {
    const noAtr = point(0.25, -0.02, 0.20, 0);
    const c = classifyExit(noAtr, { stopPct: 0.075, targetPct: 0.192 });
    expect(c.outcome).toBe("target");
    expect(c.ret).toBeCloseTo(0.192);
  });

  it("scales with each decision's own ATR, not a fixed percentage", () => {
    // Same excursions, half the volatility: a 3-ATR target is now only +4.5%,
    // so a +5% MFE reaches it where at 3% ATR it would not have.
    expect(classifyExit(point(0.05, -0.02, 0.04, 0.03), G).outcome).toBe("timeout");
    expect(classifyExit(point(0.05, -0.02, 0.04, 0.015), G).outcome).toBe("target");
  });
});

describe("evaluateGeometry", () => {
  it("excludes ambiguous decisions from the mean rather than defaulting them to zero", () => {
    const r = evaluateGeometry([
      point(0.10, -0.02, 0.07),  // target  +0.09
      point(0.10, -0.08, 0.03),  // ambiguous — excluded
    ], G);
    expect(r.n).toBe(2);
    expect(r.ambiguous).toBe(1);
    expect(r.meanReturn).toBeCloseTo(0.09); // not 0.045
  });

  it("marks itself unusable when too many orderings are unresolved", () => {
    const points = [
      ...Array.from({ length: 3 }, () => point(0.10, -0.08, 0.03)), // ambiguous
      ...Array.from({ length: 7 }, () => point(0.02, -0.03, 0.01)), // timeout
    ];
    const r = evaluateGeometry(points, G);
    expect(r.ambiguousShare).toBeCloseTo(0.3);
    expect(r.ambiguousShare).toBeGreaterThan(MAX_AMBIGUOUS_SHARE);
    expect(r.usable).toBe(false);
  });

  it("is usable when unresolved orderings are rare", () => {
    const points = [
      point(0.10, -0.08, 0.03),
      ...Array.from({ length: 19 }, () => point(0.02, -0.03, 0.01)),
    ];
    const r = evaluateGeometry(points, G);
    expect(r.ambiguousShare).toBeCloseTo(0.05);
    expect(r.usable).toBe(true);
  });

  it("an empty set is never usable and reports no mean", () => {
    const r = evaluateGeometry([], G);
    expect(r.usable).toBe(false);
    expect(r.meanReturn).toBeNull();
    expect(r.winRate).toBeNull();
  });

  it("a shorter target converts timeouts into target hits — the effect being tested", () => {
    const points = Array.from({ length: 10 }, () => point(0.05, -0.02, 0.03));
    const far = evaluateGeometry(points, { stopAtr: 2.8, targetAtr: 7.3 });
    const near = evaluateGeometry(points, { stopAtr: 2.8, targetAtr: 1.5 });
    expect(far.target).toBe(0);
    expect(far.timeout).toBe(10);
    expect(near.target).toBe(10);
    expect(near.meanReturn).toBeCloseTo(0.045);
  });
});

describe("candidate grid", () => {
  it("includes the supplied market configuration as an explicit baseline", () => {
    // A comparison with no incumbent is a sales pitch, not a test.
    const baseline = { stopPct: 0.07, targetPct: 0.08 };
    const grid = buildCandidateGeometries(baseline);
    expect(isBaseline(grid[0], baseline)).toBe(true);
    expect(grid.filter((geometry) => isBaseline(geometry, baseline))).toHaveLength(1);
    expect(grid[0].stopPct).toBeCloseTo(0.07);
    expect(grid[0].targetPct).toBeCloseTo(0.08);
  });

  it("varies stop and target independently so their effects separate", () => {
    const pct = buildCandidateGeometries({ stopPct: 0.07, targetPct: 0.08 }).filter((g) => g.stopPct != null);
    expect(new Set(pct.map((g) => g.stopPct)).size).toBeGreaterThan(1);
    expect(new Set(pct.map((g) => g.targetPct)).size).toBeGreaterThan(1);
  });

  it("carries both a percentage and an ATR grid", () => {
    const grid = buildCandidateGeometries({ stopPct: 0.07, targetPct: 0.08 });
    expect(grid.some((g) => g.stopPct != null)).toBe(true);
    expect(grid.some((g) => g.stopAtr != null)).toBe(true);
  });
});
