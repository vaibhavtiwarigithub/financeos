import { describe, it, expect } from "vitest";
import {
  buildPurgedFolds,
  validateFoldDisjointness,
  sessionsPerFold,
  aggregateOosIc,
  SIGMA_PLAN_CEILING,
} from "./folds";

/** Synthetic ascending session calendar — trading dates only, no gaps to reason about. */
const sessions = (n: number) => Array.from({ length: n }, (_, i) => `S${String(i).padStart(4, "0")}`);

// The approved layout: 3 folds x 8 dates, step = horizon = 20 (Annex F).
const APPROVED = { horizonSessions: 20, foldCount: 3, datesPerFold: 8, stepSessions: 20 };

describe("sessionsPerFold", () => {
  it("counts as-of dates plus the final label's maturity", () => {
    // 7 gaps x 20 + 20 for the last label + the first session itself.
    expect(sessionsPerFold(APPROVED)).toBe(161);
  });
});

describe("buildPurgedFolds", () => {
  it("builds the approved layout inside the ~2-year window", () => {
    // 3 x 161 = 483 sessions ~ 1.9 years, within the ~500 the entitlement allows.
    const r = buildPurgedFolds({ ...APPROVED, sessions: sessions(500) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sessionsRequired).toBe(483);
    expect(r.folds).toHaveLength(3);
    expect(r.folds.every((f) => f.asOfDates.length === 8)).toBe(true);
  });

  it("purges: each fold starts only after the previous label matures", () => {
    const r = buildPurgedFolds({ ...APPROVED, sessions: sessions(500) });
    if (!r.ok) throw new Error("expected ok");
    for (let k = 1; k < r.folds.length; k++) {
      expect(r.folds[k].startIndex).toBeGreaterThan(r.folds[k - 1].labelEndIndex);
    }
    expect(validateFoldDisjointness(r.folds).ok).toBe(true);
  });

  it("spaces as-of dates by exactly the step", () => {
    const r = buildPurgedFolds({ ...APPROVED, sessions: sessions(500) });
    if (!r.ok) throw new Error("expected ok");
    const idx = r.folds[0].asOfDates.map((d) => Number(d.slice(1)));
    for (let i = 1; i < idx.length; i++) expect(idx[i] - idx[i - 1]).toBe(20);
  });

  it("refuses a step below the horizon — that is the legacy overlap defect", () => {
    const r = buildPurgedFolds({ ...APPROVED, stepSessions: 5, sessions: sessions(5000) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("step_below_horizon");
  });

  it("refuses rather than emitting a short final fold", () => {
    // One session short of the 483 needed.
    const r = buildPurgedFolds({ ...APPROVED, sessions: sessions(482) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("insufficient_sessions");
      expect(r.sessionsRequired).toBe(483);
      expect(r.sessionsAvailable).toBe(482);
    }
  });

  it("rejects nonsense plans", () => {
    const r = buildPurgedFolds({ ...APPROVED, foldCount: 0, sessions: sessions(500) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_plan");
  });
});

describe("validateFoldDisjointness", () => {
  it("catches an overlap the builder did not produce", () => {
    // Hand-built violation: fold 1 starts before fold 0's label matures.
    const bad = [
      { index: 0, asOfDates: ["a"], labelEndDate: "z", startIndex: 0, labelEndIndex: 100 },
      { index: 1, asOfDates: ["b"], labelEndDate: "y", startIndex: 90, labelEndIndex: 200 },
    ];
    const v = validateFoldDisjointness(bad);
    expect(v.ok).toBe(false);
    expect(v.violations[0]).toContain("overlap");
  });
});

describe("aggregateOosIc", () => {
  const series = (ics: number[]) =>
    ics.map((ic, i) => ({ date: `S${String(i).padStart(4, "0")}`, ic, foldIndex: Math.floor(i / 8) }));

  it("reports realized sigma and flags it against the plan ceiling", () => {
    // Tight series -> small sigma -> plan holds.
    const a = aggregateOosIc(series([0.05, 0.055, 0.045, 0.05, 0.06]), 20, 20)!;
    expect(a.sigmaIc).toBeLessThan(SIGMA_PLAN_CEILING);
    expect(a.sigmaWithinPlan).toBe(true);
    expect(a.meanIc).toBeCloseTo(0.052, 3);
    expect(a.n).toBe(5);
  });

  it("flags sigma ABOVE the ceiling — the Annex F stop condition", () => {
    // Legacy overlapping windows measured ~0.438. At that dispersion the
    // approved floors need ~480 dates, not 25, so the plan must be re-derived.
    const a = aggregateOosIc(series([0.5, -0.4, 0.45, -0.35, 0.4]), 20, 20)!;
    expect(a.sigmaIc).toBeGreaterThan(SIGMA_PLAN_CEILING);
    expect(a.sigmaWithinPlan).toBe(false);
  });

  it("uses lag 1 when step equals horizon — non-overlapping needs no correction", () => {
    const a = aggregateOosIc(series([0.05, 0.04, 0.06]), 20, 20)!;
    expect(a.lag).toBe(1);
  });

  it("records per-fold sign for the consistency diagnostic", () => {
    const rows = [
      { date: "S0", ic: 0.05, foldIndex: 0 },
      { date: "S1", ic: 0.04, foldIndex: 0 },
      { date: "S2", ic: -0.03, foldIndex: 1 },
      { date: "S3", ic: -0.02, foldIndex: 1 },
      { date: "S4", ic: 0.06, foldIndex: 2 },
    ];
    expect(aggregateOosIc(rows, 20, 20)!.foldSigns).toEqual([1, -1, 1]);
  });

  it("drops non-finite ICs and returns null below two observations", () => {
    expect(aggregateOosIc(series([0.05]), 20, 20)).toBeNull();
    const a = aggregateOosIc(
      [
        { date: "S0", ic: 0.05, foldIndex: 0 },
        { date: "S1", ic: NaN, foldIndex: 0 },
        { date: "S2", ic: 0.03, foldIndex: 0 },
      ],
      20, 20,
    )!;
    expect(a.n).toBe(2);
  });

  it("is order-independent — it sorts by date before computing", () => {
    const asc = aggregateOosIc(series([0.05, 0.04, 0.06, 0.03]), 20, 20)!;
    const desc = aggregateOosIc(series([0.05, 0.04, 0.06, 0.03]).reverse(), 20, 20)!;
    expect(desc.meanIc).toBeCloseTo(asc.meanIc, 12);
    expect(desc.sigmaIc).toBeCloseTo(asc.sigmaIc, 12);
  });
});
