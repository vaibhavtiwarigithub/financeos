import { createServiceClient } from "@/lib/supabase/service";
import { PIT_POLICY_VERSION } from "@/lib/edges/pit-universe";
import { sha256Fingerprint } from "@/lib/edges/fingerprint";
import {
  orchestrateOosRun,
  type OrchestrationReport,
} from "@/lib/edges/oos-orchestrator";
import type { EdgeDef, Market } from "@/lib/edges/types";

export interface OosVariant {
  id: string;
  universeSize: number;
  minSymbols: number;
  minCrossSection: number;
}

export interface OosExperimentManifest {
  schemaVersion: 1;
  hypothesis: string;
  author: "human" | "llm";
  edgeId: string;
  formulaVersion: string;
  expectedSign: 1 | -1;
  market: Market;
  horizonSessions: number;
  validationMode: "purged_temporal_oos";
  trialFamilyId: string;
  trialsConsidered: number;
  universePolicyVersion: string;
  benchmarkSymbol: string;
  foldCount: number;
  datesPerFold: number;
  stepSessions: number;
  historyDays: number;
  liquidityWindowSessions: number;
  membershipCadence: "per_date";
  persistSnapshots: true;
  minimumEvaluatedDates: number;
  dataCutoff: string;
  codeVersion: string;
  hac: {
    primaryLag: number;
    sensitivityLags: number[];
  };
  costPolicy: {
    oneWayBps: number;
    includedInIc: false;
    requiredBeforePromotion: true;
  };
  multipleTesting: {
    method: "trial_adjusted_t_margin";
    familyDefinition: string;
  };
  variants: OosVariant[];
}

function assertIsoDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${field} must be an ISO date.`);
  }
}

export function validateOosManifest(manifest: OosExperimentManifest): void {
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported OOS manifest schema.");
  if (!manifest.hypothesis.trim()) throw new Error("hypothesis is required.");
  if (!manifest.edgeId.trim() || !manifest.formulaVersion.trim()) {
    throw new Error("edgeId and formulaVersion are required.");
  }
  if (!["us", "india"].includes(manifest.market)) throw new Error("market is invalid.");
  if (manifest.validationMode !== "purged_temporal_oos") {
    throw new Error("Only purged_temporal_oos is currently admissible.");
  }
  if (manifest.universePolicyVersion !== PIT_POLICY_VERSION) {
    throw new Error(`Universe policy must be ${PIT_POLICY_VERSION}.`);
  }
  if (manifest.membershipCadence !== "per_date" || manifest.persistSnapshots !== true) {
    throw new Error("OOS evidence requires persisted per-date PIT membership.");
  }
  if (manifest.horizonSessions < 1 || manifest.stepSessions !== manifest.horizonSessions) {
    throw new Error("stepSessions must equal horizonSessions to avoid label overlap.");
  }
  if (manifest.foldCount < 1 || manifest.datesPerFold < 2) {
    throw new Error("At least one fold and two dates per fold are required.");
  }
  const plannedDates = manifest.foldCount * manifest.datesPerFold;
  if (manifest.minimumEvaluatedDates < 2 || manifest.minimumEvaluatedDates > plannedDates) {
    throw new Error("minimumEvaluatedDates must be within the predeclared plan.");
  }
  if (manifest.trialsConsidered !== manifest.variants.length || manifest.variants.length < 1) {
    throw new Error("trialsConsidered must equal the predeclared variant count.");
  }
  const ids = new Set<string>();
  for (const variant of manifest.variants) {
    if (!variant.id.trim() || ids.has(variant.id)) throw new Error("Variant IDs must be unique.");
    ids.add(variant.id);
    if (
      variant.universeSize < 1
      || variant.minSymbols < 1
      || variant.minCrossSection < 3
      || variant.minSymbols > variant.universeSize
      || variant.minCrossSection > variant.universeSize
    ) {
      throw new Error(`Variant ${variant.id} has invalid universe floors.`);
    }
  }
  if (!/^[0-9a-f]{7,40}$/.test(manifest.codeVersion)) {
    throw new Error("codeVersion must be a git commit SHA.");
  }
  if (manifest.hac.primaryLag < 0 || manifest.hac.sensitivityLags.some((lag) => lag < 0)) {
    throw new Error("HAC lags must be non-negative.");
  }
  if (manifest.costPolicy.oneWayBps < 0) throw new Error("Cost policy cannot be negative.");
  assertIsoDate(manifest.dataCutoff, "dataCutoff");
}

export function fingerprintOosManifest(manifest: OosExperimentManifest): string {
  validateOosManifest(manifest);
  return sha256Fingerprint(manifest);
}

export function assertManifestMatchesEdge(manifest: OosExperimentManifest, edge: EdgeDef): void {
  if (manifest.edgeId !== edge.id || manifest.expectedSign !== edge.expectedSign) {
    throw new Error("Manifest edge identity does not match the executable edge.");
  }
  if (edge.minCandles > manifest.historyDays) {
    throw new Error("Manifest history does not cover the edge minimum candle requirement.");
  }
}

export async function runBoundOosVariant(opts: {
  manifest: OosExperimentManifest;
  variantId: string;
  edge: EdgeDef;
  apiKey?: string;
  onProgress?: (message: string) => void;
}): Promise<OrchestrationReport> {
  const { manifest, edge } = opts;
  validateOosManifest(manifest);
  assertManifestMatchesEdge(manifest, edge);
  const variant = manifest.variants.find((item) => item.id === opts.variantId);
  if (!variant) throw new Error(`Variant ${opts.variantId} was not predeclared.`);

  const report = await orchestrateOosRun({
    edge,
    market: manifest.market,
    horizonSessions: manifest.horizonSessions,
    foldCount: manifest.foldCount,
    datesPerFold: manifest.datesPerFold,
    universeSize: variant.universeSize,
    minSymbols: variant.minSymbols,
    minCrossSection: variant.minCrossSection,
    benchmarkSymbol: manifest.benchmarkSymbol,
    historyDays: manifest.historyDays,
    liquidityWindowSessions: manifest.liquidityWindowSessions,
    membershipCadence: manifest.membershipCadence,
    persistSnapshots: manifest.persistSnapshots,
    dataCutoff: manifest.dataCutoff,
    apiKey: opts.apiKey,
    onProgress: opts.onProgress,
  });

  if (report.dataCutoff !== manifest.dataCutoff || report.run?.edgeId !== manifest.edgeId) {
    throw new Error("OOS report identity does not match its manifest.");
  }
  report.planFingerprint = fingerprintOosManifest(manifest);
  report.variantId = variant.id;
  report.runFingerprint = sha256Fingerprint({
    planFingerprint: report.planFingerprint,
    variantId: variant.id,
    datasetFingerprint: report.datasetFingerprint,
    universeFingerprint: report.universeFingerprint,
    run: report.run,
  });
  return report;
}

type ServiceClient = ReturnType<typeof createServiceClient>;

export async function registerOosExperiment(
  manifest: OosExperimentManifest,
  client: ServiceClient = createServiceClient(),
): Promise<{ id: string; planFingerprint: string }> {
  const planFingerprint = fingerprintOosManifest(manifest);
  const row = {
    hypothesis: manifest.hypothesis,
    author: manifest.author,
    variant_budget: manifest.variants.length,
    variants: manifest.variants,
    variants_proposed: manifest.variants.length,
    experiment_type: "oos_ic",
    market: manifest.market,
    segment_type: "market",
    segment_value: "all",
    edge_id: manifest.edgeId,
    formula_version: manifest.formulaVersion,
    horizon_sessions: manifest.horizonSessions,
    validation_mode: manifest.validationMode,
    trial_family_id: manifest.trialFamilyId,
    trials_considered: manifest.trialsConsidered,
    universe_policy_version: manifest.universePolicyVersion,
    data_cutoff: manifest.dataCutoff,
    code_version: manifest.codeVersion,
    validation_spec: manifest,
    plan_fingerprint: planFingerprint,
    started_at: new Date().toISOString(),
  };
  const { data, error } = await client
    .from("backtest_experiments")
    .insert(row)
    .select("id,plan_fingerprint")
    .single();
  if (error || !data?.id || data.plan_fingerprint !== planFingerprint) {
    throw new Error(`Failed to register immutable OOS experiment: ${error?.message ?? "invalid acknowledgement"}`);
  }
  return { id: data.id, planFingerprint };
}

export async function completeOosExperiment(opts: {
  experimentId: string;
  manifest: OosExperimentManifest;
  reports: OrchestrationReport[];
  client?: ServiceClient;
}): Promise<void> {
  const client = opts.client ?? createServiceClient();
  const planFingerprint = fingerprintOosManifest(opts.manifest);
  const expectedVariants = new Set(opts.manifest.variants.map((variant) => variant.id));
  if (
    opts.reports.length !== expectedVariants.size
    || opts.reports.some((report) => !report.variantId || !expectedVariants.delete(report.variantId))
    || expectedVariants.size
  ) {
    throw new Error("Completion requires exactly one report for every predeclared variant.");
  }
  if (opts.reports.some((report) =>
    report.fatal
    || report.planFingerprint !== planFingerprint
    || !report.runFingerprint
    || !report.datasetFingerprint
    || !report.universeFingerprint
    || (report.run?.datesEvaluated ?? 0) < opts.manifest.minimumEvaluatedDates
  )) {
    throw new Error("OOS experiment is incomplete or does not match its immutable plan.");
  }
  const datasetFingerprint = sha256Fingerprint(
    opts.reports.map((report) => [report.variantId, report.datasetFingerprint]).sort(),
  );
  const universeFingerprint = sha256Fingerprint(
    opts.reports.map((report) => [report.variantId, report.universeFingerprint]).sort(),
  );
  const runFingerprint = sha256Fingerprint(
    opts.reports.map((report) => [report.variantId, report.runFingerprint]).sort(),
  );
  const { data, error } = await client
    .from("backtest_experiments")
    .update({
      variants_run: opts.reports.length,
      completed_at: new Date().toISOString(),
      result_summary: { schemaVersion: 1, reports: opts.reports },
      dataset_fingerprint: datasetFingerprint,
      universe_fingerprint: universeFingerprint,
      run_fingerprint: runFingerprint,
    })
    .eq("id", opts.experimentId)
    .eq("plan_fingerprint", planFingerprint)
    .is("completed_at", null)
    .select("id");
  if (error || !Array.isArray(data) || data.length !== 1) {
    throw new Error(`Failed to complete OOS experiment exactly once: ${error?.message ?? "row mismatch"}`);
  }
}
