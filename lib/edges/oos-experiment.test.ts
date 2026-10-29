import { describe, expect, it, vi } from "vitest";
import { PIT_POLICY_VERSION } from "./pit-universe";
import {
  completeOosExperiment,
  fingerprintOosManifest,
  registerOosExperiment,
  validateOosManifest,
  type OosExperimentManifest,
} from "./oos-experiment";
import { canonicalJson } from "./fingerprint";

function manifest(): OosExperimentManifest {
  return {
    schemaVersion: 2,
    hypothesis: "A larger PIT cross-section changes measured h5 momentum IC dispersion.",
    author: "human",
    edgeId: "mom_12_1",
    formulaVersion: "mom_12_1_v1",
    expectedSign: 1,
    market: "us",
    horizonSessions: 5,
    validationMode: "purged_temporal_oos",
    trialFamilyId: "mom_12_1-us-h5-universe-size-20260729",
    trialsConsidered: 2,
    universePolicyVersion: PIT_POLICY_VERSION,
    benchmarkSymbol: "SPY",
    foldCount: 2,
    datesPerFold: 6,
    stepSessions: 5,
    historyDays: 1825,
    liquidityWindowSessions: 480,
    membershipCadence: "per_date",
    persistSnapshots: true,
    minimumEvaluatedDates: 10,
    dataCutoff: "2026-07-28",
    codeVersion: "abcdef1",
    hac: { primaryLag: 0, sensitivityLags: [1, 2, 4] },
    costPolicy: { oneWayBps: 10, includedInIc: false, requiredBeforePromotion: true },
    multipleTesting: {
      method: "benjamini_yekutieli",
      alpha: 0.05,
      familyDefinition: "All universe-size variants in this immutable experiment.",
    },
    variants: [
      { id: "n200", universeSize: 200, minSymbols: 100, minCrossSection: 100 },
      { id: "n400", universeSize: 400, minSymbols: 200, minCrossSection: 200 },
    ],
  };
}

describe("OOS experiment manifest", () => {
  it("has a canonical fingerprint independent of object key insertion order", () => {
    const a = manifest();
    const b = JSON.parse(canonicalJson(a)) as OosExperimentManifest;
    expect(fingerprintOosManifest(a)).toBe(fingerprintOosManifest(b));
  });

  it("refuses post-hoc variants, overlapping labels, and approximate membership", () => {
    expect(() => validateOosManifest({ ...manifest(), trialsConsidered: 3 })).toThrow(
      "predeclared variant count",
    );
    expect(() => validateOosManifest({ ...manifest(), stepSessions: 1 })).toThrow(
      "avoid label overlap",
    );
    expect(() => validateOosManifest({
      ...manifest(),
      membershipCadence: "per_fold" as "per_date",
    })).toThrow("per-date PIT");
  });

  it("requires overlap-derived primary HAC lag and unique sensitivity lags", () => {
    expect(() => validateOosManifest({ ...manifest(), hac: { primaryLag: 1, sensitivityLags: [2] } }))
      .toThrow("overlap-derived lag");
    expect(() => validateOosManifest({ ...manifest(), hac: { primaryLag: 0, sensitivityLags: [2, 2] } }))
      .toThrow("must be unique");
  });

  it("requires enough dates to form the declared reference distribution", () => {
    expect(() => validateOosManifest({ ...manifest(), minimumEvaluatedDates: 2 }))
      .toThrow("minimumEvaluatedDates must be at least 3");
  });

  it("permits an explicitly diagnostic per-fold plan without upgrading its evidence class", () => {
    expect(() => validateOosManifest({
      ...manifest(),
      evidenceClass: "diagnostic",
      membershipCadence: "per_fold",
    })).not.toThrow();
  });

  it("registers the complete immutable identity before execution", async () => {
    const single = vi.fn().mockResolvedValue({
      data: { id: "exp-1", plan_fingerprint: fingerprintOosManifest(manifest()) },
      error: null,
    });
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn(() => ({ select }));
    const client = { from: vi.fn(() => ({ insert })) } as any;
    await expect(registerOosExperiment(manifest(), client)).resolves.toMatchObject({ id: "exp-1" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      experiment_type: "oos_ic",
      edge_id: "mom_12_1",
      formula_version: "mom_12_1_v1",
      horizon_sessions: 5,
      data_cutoff: "2026-07-28",
      validation_spec: manifest(),
    }));
  });

  it("refuses completion when a variant is missing", async () => {
    await expect(completeOosExperiment({
      experimentId: "exp-1",
      manifest: manifest(),
      reports: [],
      client: {} as any,
    })).rejects.toThrow("exactly one report");
  });

  it("refuses to shrink the declared FDR family when a variant has no mature statistic", async () => {
    const m = manifest();
    const base = {
      reportSchemaVersion: 3,
      dataCutoff: m.dataCutoff,
      planFingerprint: fingerprintOosManifest(m),
      datasetFingerprint: "dataset",
      universeFingerprint: "universe",
      runFingerprint: "run",
      run: { edgeId: m.edgeId, datesEvaluated: m.minimumEvaluatedDates, aggregate: null } as any,
      folds: [],
      membershipCadence: "per_date" as const,
      approximationsUsed: [],
      universeErrors: [],
      universeSnapshots: [],
      snapshotsConfirmed: 0,
      symbolsFetched: 400,
      symbolsMissingCandles: [],
      sessionsAvailable: 500,
    };
    await expect(completeOosExperiment({
      experimentId: "exp-1",
      manifest: m,
      reports: m.variants.map((variant) => ({ ...base, variantId: variant.id } as any)),
      client: {} as any,
    })).rejects.toThrow("every variant needs a finite matured OOS HAC statistic");
  });
});
