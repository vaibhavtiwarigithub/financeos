import { evaluateVariant, type Dim, type ObsRow, type VariantDef } from "@/lib/score-variants/core";

export const MINING_DIMS: readonly Dim[] = ["fundamental", "technical", "sentiment", "insider"];
export const MINING_HORIZONS = [2, 5, 10, 20] as const;
export const WEIGHT_GRID_STEP = 0.1;

export interface MinedCandidate {
  role: "full_sample_fit" | `without_${Dim}`;
  label: string;
  weights: Partial<Record<Dim, number>>;
  sessions: number;
  independentWindows: number;
  meanIc: number | null;
  meanIcT: number | null;
  topFifthExcess: number | null;
  bottomFifthExcess: number | null;
  spread: number | null;
  spreadT: number | null;
  pairedSpreadDelta: number | null;
  pairedSpreadDeltaT: number | null;
  baselineMeanIc: number | null;
  baselineSpread: number | null;
  coverageRows: number;
  reason: string;
}

export interface FormulaMiningResult {
  horizonDays: number;
  trialsConsidered: number;
  candidates: MinedCandidate[];
  rows: number;
  qualifyingSessions: number;
  dimensionsAvailable: Dim[];
}

/** Exhaustively enumerate the predeclared 0.1-step, nonnegative, sum-to-one simplex. */
export function simplexWeightGrid(dimensions: readonly Dim[], tenths = 10): Array<Partial<Record<Dim, number>>> {
  if (!dimensions.length || dimensions.length > MINING_DIMS.length || tenths < dimensions.length) return [];
  const out: Array<Partial<Record<Dim, number>>> = [];
  const visit = (index: number, remaining: number, values: number[]) => {
    if (index === dimensions.length - 1) {
      const next = [...values, remaining];
      const weights: Partial<Record<Dim, number>> = {};
      next.forEach((units, i) => { if (units > 0) weights[dimensions[i]] = units / tenths; });
      out.push(weights);
      return;
    }
    for (let units = 0; units <= remaining; units++) visit(index + 1, remaining - units, [...values, units]);
  };
  visit(0, tenths, []);
  return out;
}

function compareCandidate(a: MinedCandidate, b: MinedCandidate): number {
  const ai = a.meanIc ?? Number.NEGATIVE_INFINITY;
  const bi = b.meanIc ?? Number.NEGATIVE_INFINITY;
  if (ai !== bi) return bi - ai;
  const as = a.spread ?? Number.NEGATIVE_INFINITY;
  const bs = b.spread ?? Number.NEGATIVE_INFINITY;
  if (as !== bs) return bs - as;
  return JSON.stringify(a.weights).localeCompare(JSON.stringify(b.weights));
}

function scoreCandidate(
  role: MinedCandidate["role"], rows: readonly ObsRow[], weights: Partial<Record<Dim, number>>, horizonDays: number,
): MinedCandidate {
  const id = Object.keys(weights).sort().join("_") || "empty";
  const def: VariantDef = { id, label: id, weights };
  const ev = evaluateVariant(def, rows, horizonDays);
  // Caller supplies one fixed complete-case cohort for every candidate. Do not
  // let a weight vector win merely because its missingness selected better names.
  const coverageRows = rows.length;
  return {
    role, label: role === "full_sample_fit" ? "Full-sample overfit fit" : `Best fit without ${role.slice("without_".length)}`,
    weights, sessions: ev.sessions, independentWindows: ev.independentWindows,
    meanIc: ev.variant.meanIc, meanIcT: ev.variant.icT, topFifthExcess: ev.variant.topFifthExcess, bottomFifthExcess: ev.variant.bottomFifthExcess,
    spread: ev.variant.spread, spreadT: ev.variant.spreadT, pairedSpreadDelta: ev.pairedSpreadDelta,
    pairedSpreadDeltaT: ev.pairedSpreadDeltaT, baselineMeanIc: ev.baseline.meanIc, baselineSpread: ev.baseline.spread,
    coverageRows, reason: ev.sessions ? "Selected by maximizing mean per-session rank IC on the same historical rows. This is intentionally in-sample and is not evidence of predictive skill." : "No qualifying complete-case cross-sections for this formula.",
  };
}

/**
 * Mine one intentionally overfit formula plus leave-one-dimension-out best fits.
 * This function is for candidate generation only. Its full-sample statistics must
 * never be used as out-of-sample evidence or as an automatic adoption gate.
 */
export function mineFormulaCandidates(rows: readonly ObsRow[], horizonDays: number): FormulaMiningResult {
  const available = MINING_DIMS.filter((dim) => rows.some((row) => row.scores[dim] != null && row.avail[dim] === true));
  const paired = rows.filter((row) => row.analyst != null && Number.isFinite(Number(row.analyst))
    && available.every((dim) => row.scores[dim] != null && Number.isFinite(Number(row.scores[dim])) && row.avail[dim] === true));
  // Labels are fetched in observation-id order; keep the last row for a
  // symbol/session, matching evaluateVariant's deterministic de-duplication.
  const deduped = new Map<string, ObsRow>();
  for (const row of paired) deduped.set(`${row.ts.slice(0, 10)}:${row.symbol}`, row);
  const commonRows = [...deduped.values()];
  const grid = simplexWeightGrid(available);
  const evaluated = grid.map((weights) => scoreCandidate("full_sample_fit", commonRows, weights, horizonDays));
  const eligible = evaluated.filter((candidate) => candidate.sessions > 0 && candidate.meanIc != null).sort(compareCandidate);
  if (!eligible.length) {
    return { horizonDays, trialsConsidered: grid.length, candidates: [], rows: commonRows.length, qualifyingSessions: 0, dimensionsAvailable: available };
  }

  const selected: MinedCandidate[] = [
    { ...eligible[0], role: "full_sample_fit", label: "Full-sample overfit fit" },
  ];
  for (const dim of available) {
    const ablation = evaluated.filter((candidate) => candidate.sessions > 0 && candidate.meanIc != null && (candidate.weights[dim] ?? 0) === 0)
      .sort(compareCandidate)[0];
    if (!ablation) continue;
    selected.push({ ...ablation, role: `without_${dim}`, label: `Best fit without ${dim}` });
  }
  return { horizonDays, trialsConsidered: grid.length, candidates: selected, rows: commonRows.length, qualifyingSessions: eligible[0].sessions, dimensionsAvailable: available };
}

/** Metadata is stored as JSON in the existing immutable registry rationale field. */
export function miningRationale(input: {
  runFingerprint: string; datasetFingerprint: string; market: "us" | "india"; horizonDays: number;
  fitCutoff: string; dimensionsAvailable: Dim[]; trialCount: number; totalRunTrials: number; candidate: MinedCandidate;
}): string {
  return JSON.stringify({
    kind: "historical_overfit_mining_v1", runFingerprint: input.runFingerprint,
    datasetFingerprint: input.datasetFingerprint, market: input.market, horizonDays: input.horizonDays,
    fitCutoff: input.fitCutoff, dimensionsAvailable: input.dimensionsAvailable,
    trialCount: input.trialCount, totalRunTrials: input.totalRunTrials, role: input.candidate.role,
    selectionMetric: "mean_per_session_spearman_ic", normalization: "weighted_mean_of_stored_dimension_scores",
    cohort: "entry_candidate_long_shared_predicate",
    missingnessPolicy: "complete-case common cohort shared across every candidate in this market/horizon",
    historicalFit: {
      sessions: input.candidate.sessions, independentWindows: input.candidate.independentWindows,
      coverageRows: input.candidate.coverageRows, meanIc: input.candidate.meanIc,
      meanIcT: input.candidate.meanIcT,
      topFifthExcess: input.candidate.topFifthExcess, bottomFifthExcess: input.candidate.bottomFifthExcess,
      spread: input.candidate.spread, spreadT: input.candidate.spreadT,
      pairedSpreadDelta: input.candidate.pairedSpreadDelta, pairedSpreadDeltaT: input.candidate.pairedSpreadDeltaT,
      baselineMeanIc: input.candidate.baselineMeanIc,
      baselineSpread: input.candidate.baselineSpread,
    },
    caveat: "INTENTIONALLY SELECTED ON THESE SAME HISTORICAL LABELS. HINDSIGHT ONLY; NOT VALIDATION OR ADOPTION EVIDENCE.",
  });
}

export function parseMiningRationale(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return value.kind === "historical_overfit_mining_v1" ? value : null;
  } catch { return null; }
}

export function asMinedVariant(row: { variant_id: string; label: string; weights: unknown; rationale: unknown }): VariantDef | null {
  const meta = parseMiningRationale(row.rationale);
  const weights = row.weights;
  if (!meta || !weights || typeof weights !== "object" || Array.isArray(weights)) return null;
  const allowed = new Set<Dim>(MINING_DIMS);
  const entries = Object.entries(weights as Record<string, unknown>);
  if (!entries.length || entries.some(([key, value]) => !allowed.has(key as Dim) || typeof value !== "number" || !Number.isFinite(value) || value < 0)) return null;
  const total = entries.reduce((sum, [, value]) => sum + Number(value), 0);
  if (Math.abs(total - 1) > 1e-6) return null;
  return { id: row.variant_id, label: row.label, weights: weights as Partial<Record<Dim, number>> };
}
