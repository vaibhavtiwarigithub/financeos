// Semantic parity comparator + frozen cohort evaluation — proof (§4, §5, §11).

import { describe, expect, it } from "vitest";
import {
  basesComparable,
  compareField,
  comparatorFor,
  type FieldObservationForParity,
} from "@/lib/evidence/evaluation/parity";
import {
  evaluateCohort,
  scorePath,
  cohortFingerprint,
  EVALUATION_CODE_VERSION,
  type CohortRow,
  type FrozenCohort,
  type PathObservation,
} from "@/lib/evidence/evaluation/cohort";
import {
  classifyIntent,
  contractClassViolations,
  fieldContract,
  gatedIntents,
} from "@/lib/evidence/intent-classification";
import type { DimensionRecord } from "@/lib/scoring/weighted-score";

const OBS = (over: Partial<FieldObservationForParity> = {}): FieldObservationForParity => ({
  value: 10,
  present: true,
  quality: "fresh",
  basis: "ttm",
  periodEnd: "2026-03-31",
  currency: "USD",
  unit: "ratio",
  providerId: "finnhub",
  ...over,
});

const FIELD = "fundamental.reported_core";
const cmp = (l: FieldObservationForParity, c: FieldObservationForParity, fieldId = FIELD) =>
  compareField(l, c, fieldContract(fieldId), comparatorFor(fieldId));

describe("parity — semantic axes are exact, never tolerated", () => {
  it("identical observations match", () => {
    expect(cmp(OBS(), OBS({ providerId: "yahoo" })).code).toBe("identical");
  });

  it("NO tolerance across TTM vs quarterly — even when the numbers are identical", () => {
    const r = cmp(OBS({ basis: "ttm" }), OBS({ basis: "quarterly" }));
    expect(r.code).toBe("basis_mismatch");
    expect(r.hardFail).toBe(true);
  });

  it("NO tolerance across TTM vs forward", () => {
    expect(cmp(OBS({ basis: "ttm" }), OBS({ basis: "forward" })).code).toBe("basis_mismatch");
  });

  it("NO tolerance across annual vs quarterly", () => {
    expect(basesComparable("annual", "quarterly")).toBe(false);
    expect(basesComparable("ttm", "ttm")).toBe(true);
  });

  it("adjusted vs unadjusted is a hard mismatch, not a delta", () => {
    const l = OBS({ basis: "eod", unit: "currency", adjusted: true, periodEnd: null });
    const c = OBS({ basis: "eod", unit: "currency", adjusted: false, periodEnd: null });
    const r = compareField(l, c, fieldContract("technical.daily_bars"), comparatorFor("technical.daily_bars"));
    expect(r.code).toBe("adjustment_mismatch");
    expect(r.hardFail).toBe(true);
  });

  it("a different fiscal period is a different fact", () => {
    expect(cmp(OBS({ periodEnd: "2026-03-31" }), OBS({ periodEnd: "2025-12-31" })).code).toBe("period_mismatch");
  });

  it("currency and unit mismatches are hard failures", () => {
    expect(cmp(OBS({ currency: "USD" }), OBS({ currency: "INR" })).code).toBe("currency_mismatch");
    expect(cmp(OBS({ unit: "ratio" }), OBS({ unit: "per_share" })).code).toBe("unit_mismatch");
  });

  it("a candidate basis outside the field contract fails even if both paths agree on it", () => {
    const r = cmp(OBS({ basis: "quarterly" }), OBS({ basis: "quarterly" }));
    // The contract pins TTM — Webull's quarterly fundamentals cannot slide in.
    expect(r.code).toBe("basis_mismatch");
  });

  it("missing field-level provenance fails rather than passing quietly", () => {
    expect(cmp(OBS(), OBS({ providerId: null })).code).toBe("provenance_missing");
  });

  it("retains conflict state instead of resolving it into a neutral value", () => {
    expect(cmp(OBS(), OBS({ conflict: true })).code).toBe("quality_degraded");
  });
});

describe("parity — numeric tolerance applies only after normalization", () => {
  it("a small same-contract difference is within documented tolerance", () => {
    const r = cmp(OBS({ value: 10 }), OBS({ value: 10.02 }));
    expect(r.code).toBe("value_within_tolerance");
    expect(r.agrees).toBe(true);
  });

  it("a large same-contract difference is outside tolerance", () => {
    const r = cmp(OBS({ value: 10 }), OBS({ value: 14 }));
    expect(r.code).toBe("value_outside_tolerance");
    expect(r.agrees).toBe(false);
  });

  it("exact-only fields (enums) get no tolerance at all", () => {
    const l = OBS({ value: "risk_on", basis: "spot", unit: "ratio", periodEnd: null });
    const c = OBS({ value: "risk_off", basis: "spot", unit: "ratio", periodEnd: null });
    const r = compareField(l, c, fieldContract("macro.regime"), comparatorFor("macro.regime"));
    expect(r.code).toBe("value_outside_tolerance");
  });

  it("an unknown field defaults to exact-match, never to a permissive tolerance", () => {
    expect(comparatorFor("some.new.field").exactOnly).toBe(true);
    expect(comparatorFor("some.new.field").relativeTolerance).toBe(0);
  });
});

describe("parity — availability is classified, never assumed good", () => {
  it("candidate gaining coverage is 'availability_gain', not agreement", () => {
    const r = cmp(OBS({ present: false, value: null }), OBS());
    expect(r.code).toBe("availability_gain");
    expect(r.agrees).toBe(false);
  });

  it("candidate losing coverage is 'availability_loss'", () => {
    expect(cmp(OBS(), OBS({ present: false, value: null })).code).toBe("availability_loss");
  });

  it("both-unavailable rows are retained (the cohort must include abstains)", () => {
    const r = cmp(OBS({ present: false, value: null }), OBS({ present: false, value: null }));
    expect(r.code).toBe("both_unavailable");
  });
});

// ── cohort ───────────────────────────────────────────────────────────────────

const W: DimensionRecord<number> = { fundamental: 0.3, technical: 0.25, sentiment: 0.2, macro: 0.15, insider: 0.1 };
const ALL_IN: DimensionRecord<boolean> = { fundamental: true, technical: true, sentiment: true, macro: true, insider: true };

function path(over: Partial<PathObservation> = {}): PathObservation {
  return {
    status: "scored",
    scores: { fundamental: 70, technical: 70, sentiment: 70, macro: 70, insider: 70 },
    included: { ...ALL_IN },
    fields: { [FIELD]: OBS() },
    ...over,
  };
}

function cohortOf(rows: CohortRow[], over: Partial<FrozenCohort> = {}): FrozenCohort {
  return {
    evaluationId: "eval-1",
    market: "us",
    asOf: "2026-07-16T00:00:00.000Z",
    universeSnapshotId: "snap-1",
    baselinePolicyVersionId: "base-1",
    candidatePolicyVersionId: "cand-1",
    strategyVersion: "strat-1",
    weights: W,
    scoreThreshold: 60,
    priceBasis: "eod_adjusted",
    rows,
    evaluationCodeVersion: EVALUATION_CODE_VERSION,
    coverageNonInferiorityMargin: 0.05,
    maxAdverseRankDisplacement: 2,
    ...over,
  };
}

const row = (symbol: string, legacy: PathObservation, candidate: PathObservation, isHeld = false): CohortRow =>
  ({ symbol, shape: "equity", isHeld, legacy, candidate });

describe("cohort — abstained/failed rows are first-class", () => {
  it("includes rows where either path abstained or failed", () => {
    const c = cohortOf([
      row("AAA", path(), path()),
      row("BBB", path({ status: "failed", failureReason: "timeout" }), path()),
      row("CCC", path(), path({ status: "abstained" })),
    ]);
    const e = evaluateCohort(c);
    expect(e.counts.symbols).toBe(3);
    expect(e.deltas.map((d) => d.symbol).sort()).toEqual(["AAA", "BBB", "CCC"]);
    expect(e.counts.legacyAbstainedOrFailed).toBe(1);
    expect(e.counts.candidateAbstainedOrFailed).toBe(1);
  });

  it("a failed path is never eligible and never ranked", () => {
    const scored = scorePath(cohortOf([row("AAA", path({ status: "failed" }), path())]), "legacy");
    expect(scored[0].eligible).toBe(false);
    expect(scored[0].rank).toBeNull();
    expect(scored[0].score).toBeNull();
  });
});

describe("cohort — a routing artifact may never create a new long (§5)", () => {
  it("BLOCKS eligibility created only by weight renormalization", () => {
    // Legacy: insider present but zero → 63*0.9 = 57 → below the 60 threshold.
    // Candidate: insider dropped, the 0.1 weight redistributes onto the other
    // four dims → 63 → clears the threshold. Not one new fact. Must not pass.
    const legacy = path({
      scores: { fundamental: 63, technical: 63, sentiment: 63, macro: 63, insider: 0 },
      included: { ...ALL_IN },
    });
    const candidate = path({
      scores: { fundamental: 63, technical: 63, sentiment: 63, macro: 63, insider: 0 },
      included: { ...ALL_IN, insider: false },
    });
    const e = evaluateCohort(cohortOf([row("AAA", legacy, candidate)]));
    const d = e.deltas[0];
    expect(d.legacy.eligible).toBe(false);
    expect(d.candidate.eligible).toBe(true);
    expect(d.flip).toBe("ineligible_to_eligible");
    expect(d.cause).toBe("weight_renormalization");
    expect(d.blocking).toBe(true);
    expect(e.passed).toBe(false);
    expect(e.failures.some((f) => f.code === "artifact_created_eligibility")).toBe(true);
  });

  it("BLOCKS eligibility created only by added source availability", () => {
    // Legacy has no fundamentals: renormalizes onto the rest → 55 → ineligible.
    // Candidate simply HAS the field (0.3 × 95) → 67 → eligible. The company did
    // not change; only our provider coverage did.
    const legacy = path({
      scores: { fundamental: 0, technical: 55, sentiment: 55, macro: 55, insider: 55 },
      included: { ...ALL_IN, fundamental: false },
      fields: { [FIELD]: OBS({ present: false, value: null }) },
    });
    const candidate = path({
      scores: { fundamental: 95, technical: 55, sentiment: 55, macro: 55, insider: 55 },
      included: { ...ALL_IN },
      fields: { [FIELD]: OBS({ value: 95 }) },
    });
    const e = evaluateCohort(cohortOf([row("AAA", legacy, candidate)]));
    expect(e.deltas[0].cause).toBe("source_availability");
    expect(e.passed).toBe(false);
    expect(e.failures.some((f) => f.code === "artifact_created_eligibility")).toBe(true);
  });

  it("BLOCKS eligibility created only by a stale fallback", () => {
    const legacy = path({ scores: { fundamental: 10, technical: 10, sentiment: 10, macro: 10, insider: 10 } });
    const candidate = path({ staleFallback: true, scores: { fundamental: 90, technical: 90, sentiment: 90, macro: 90, insider: 90 }, fields: { [FIELD]: OBS({ value: 90 }) } });
    const e = evaluateCohort(cohortOf([row("AAA", legacy, candidate)]));
    expect(e.deltas[0].cause).toBe("stale_fallback");
    expect(e.passed).toBe(false);
  });

  it("BLOCKS eligibility created only by conflict resolution", () => {
    const legacy = path({ scores: { fundamental: 10, technical: 10, sentiment: 10, macro: 10, insider: 10 } });
    const candidate = path({ conflictResolved: true, scores: { fundamental: 90, technical: 90, sentiment: 90, macro: 90, insider: 90 }, fields: { [FIELD]: OBS({ value: 90 }) } });
    const e = evaluateCohort(cohortOf([row("AAA", legacy, candidate)]));
    expect(e.deltas[0].cause).toBe("conflict_resolution");
    expect(e.passed).toBe(false);
  });

  it("BLOCKS eligibility created by a basis mapping difference", () => {
    const legacy = path({ scores: { fundamental: 10, technical: 10, sentiment: 10, macro: 10, insider: 10 } });
    const candidate = path({
      scores: { fundamental: 90, technical: 90, sentiment: 90, macro: 90, insider: 90 },
      fields: { [FIELD]: OBS({ value: 90, basis: "quarterly" }) },
    });
    const e = evaluateCohort(cohortOf([row("AAA", legacy, candidate)]));
    expect(e.deltas[0].cause).toBe("basis_mapping");
    expect(e.passed).toBe(false);
  });

  it("a GENUINE same-contract value change is classified as such — not confused with availability — but still needs owner review", () => {
    const legacy = path({
      scores: { fundamental: 10, technical: 55, sentiment: 55, macro: 55, insider: 55 },
      fields: { [FIELD]: OBS({ value: 10 }) },
    });
    const candidate = path({
      // Same contract on every axis; the fact itself moved.
      scores: { fundamental: 95, technical: 55, sentiment: 55, macro: 55, insider: 55 },
      fields: { [FIELD]: OBS({ value: 95 }) },
    });
    const e = evaluateCohort(cohortOf([row("AAA", legacy, candidate)]));
    expect(e.deltas[0].cause).toBe("genuine_value_change");
    // Not auto-blocked as an artifact...
    expect(e.deltas[0].blocking).toBe(false);
    // ...but it cannot self-approve: added coverage is measured, not approved.
    expect(e.requiresOwnerReview).toHaveLength(1);
    expect(e.passed).toBe(true);
    expect(e.failures).toEqual([]);
  });

  it("becoming MORE conservative (eligible → ineligible) never blocks", () => {
    const legacy = path({ scores: { fundamental: 90, technical: 90, sentiment: 90, macro: 90, insider: 90 }, fields: { [FIELD]: OBS({ value: 90 }) } });
    const candidate = path({ scores: { fundamental: 20, technical: 20, sentiment: 20, macro: 20, insider: 20 }, fields: { [FIELD]: OBS({ value: 90 }) } });
    const e = evaluateCohort(cohortOf([row("AAA", legacy, candidate)]));
    expect(e.deltas[0].flip).toBe("eligible_to_ineligible");
    expect(e.passed).toBe(true);
  });

  it("an identical cohort passes", () => {
    const e = evaluateCohort(cohortOf([row("AAA", path(), path()), row("BBB", path(), path())]));
    expect(e.failures).toEqual([]);
    expect(e.passed).toBe(true);
    expect(e.counts.newlyEligible).toBe(0);
  });
});

describe("cohort — ranks are cohort-level, not per-symbol", () => {
  it("ranks eligible symbols by score across the frozen cohort", () => {
    const hi = path({ scores: { fundamental: 95, technical: 95, sentiment: 95, macro: 95, insider: 95 } });
    const mid = path({ scores: { fundamental: 75, technical: 75, sentiment: 75, macro: 75, insider: 75 } });
    const lo = path({ scores: { fundamental: 20, technical: 20, sentiment: 20, macro: 20, insider: 20 } });
    const scored = scorePath(cohortOf([row("AAA", mid, mid), row("BBB", hi, hi), row("CCC", lo, lo)]), "legacy");
    const byRank = scored.filter((s) => s.rank !== null).sort((a, b) => a.rank! - b.rank!);
    expect(byRank.map((s) => s.symbol)).toEqual(["BBB", "AAA"]);
    expect(scored.find((s) => s.symbol === "CCC")!.rank).toBeNull();
  });

  it("catches adverse rank displacement caused only by missingness", () => {
    // AAA keeps its value; the candidate loses AAA's fundamental field, which
    // pushes it down the cohort. Two other names ride up in its place.
    const strong = path({ scores: { fundamental: 99, technical: 99, sentiment: 99, macro: 99, insider: 99 } });
    const strongDegraded = path({
      scores: { fundamental: 0, technical: 62, sentiment: 62, macro: 62, insider: 62 },
      included: { ...ALL_IN, fundamental: false },
      fields: { [FIELD]: OBS({ present: false, value: null }) },
    });
    const other = path({ scores: { fundamental: 80, technical: 80, sentiment: 80, macro: 80, insider: 80 } });
    const e = evaluateCohort(
      cohortOf([
        row("AAA", strong, strongDegraded),
        row("BBB", other, other),
        row("CCC", other, other),
      ]),
    );
    const aaa = e.deltas.find((d) => d.symbol === "AAA")!;
    expect(aaa.legacy.rank).toBe(1);
    expect(aaa.candidate.rank).toBeGreaterThan(1);
    expect(e.failures.some((f) => f.code === "adverse_rank_displacement_from_missingness" && f.symbol === "AAA")).toBe(true);
    expect(e.passed).toBe(false);
  });

  it("a held position is never counted as newly eligible — entries only", () => {
    const strong = path({ scores: { fundamental: 95, technical: 95, sentiment: 95, macro: 95, insider: 95 } });
    const e = evaluateCohort(cohortOf([row("AAA", strong, strong, true)]));
    expect(e.deltas[0].candidate.eligible).toBe(false);
    expect(e.counts.newlyEligible).toBe(0);
  });
});

describe("cohort — coverage non-inferiority + fingerprint", () => {
  it("fails when a REQUIRED field's coverage drops beyond the approved margin", () => {
    const withField = path({ fields: { [FIELD]: OBS() } });
    const withoutField = path({ fields: { [FIELD]: OBS({ present: false, value: null }) }, included: { ...ALL_IN, fundamental: false } });
    const e = evaluateCohort(
      cohortOf([row("AAA", withField, withoutField), row("BBB", withField, withoutField)]),
    );
    expect(e.failures.some((f) => f.code === "coverage_below_non_inferiority_margin")).toBe(true);
    const stat = e.coverage.find((c) => c.fieldId === FIELD)!;
    expect(stat.applicable).toBe(2);
    expect(stat.legacyRate).toBe(1);
    expect(stat.candidateRate).toBe(0);
  });

  it("the fingerprint changes when ANY frozen input changes — a stale evaluation cannot masquerade", () => {
    const base = cohortOf([row("AAA", path(), path())]);
    const fp = cohortFingerprint(base);
    expect(cohortFingerprint(cohortOf([row("AAA", path(), path())]))).toBe(fp);
    expect(cohortFingerprint({ ...base, scoreThreshold: 65 })).not.toBe(fp);
    expect(cohortFingerprint({ ...base, asOf: "2026-07-17T00:00:00.000Z" })).not.toBe(fp);
    expect(cohortFingerprint({ ...base, strategyVersion: "strat-2" })).not.toBe(fp);
    expect(cohortFingerprint({ ...base, priceBasis: "eod_unadjusted" })).not.toBe(fp);
    expect(cohortFingerprint({ ...base, candidatePolicyVersionId: "cand-2" })).not.toBe(fp);
  });
});

describe("intent classification (§3)", () => {
  it("US analyst consensus is narrative-only and India's is unsupported", () => {
    expect(classifyIntent("analyst.consensus", "us")).toBe("narrative_only");
    expect(classifyIntent("analyst.consensus", "india")).toBe("unsupported");
  });

  it("analyst.consensus is NOT a gated intent in either market — it can never block a scoring cutover", () => {
    expect(gatedIntents("us")).not.toContain("analyst.consensus");
    expect(gatedIntents("india")).not.toContain("analyst.consensus");
  });

  it("India's unsupported intents do not shrink the US gated set", () => {
    expect(gatedIntents("us").length).toBeGreaterThanOrEqual(gatedIntents("india").length);
    for (const i of gatedIntents("india")) expect(gatedIntents("us")).toContain(i);
  });

  it("scoring dimensions map only to score_affecting intents", () => {
    expect(contractClassViolations()).toEqual([]);
  });

  it("every scoring intent classifies as score_affecting in both markets", () => {
    for (const i of ["price.daily_bars", "fundamentals.reported", "sentiment.news", "macro.regime_inputs"] as const) {
      expect(classifyIntent(i, "us")).toBe("score_affecting");
      expect(classifyIntent(i, "india")).toBe("score_affecting");
    }
  });
});
