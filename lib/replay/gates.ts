// Replay gate evaluators — thin adapters that call the REAL gate code UNCHANGED
// (draft §6). No gate logic is reimplemented here; the trustworthiness of the report
// comes from exercising the exact functions the live/validation paths use.
//
// Reused verbatim:
//   • lib/validation/calibration.ts → fitCalibration  (which itself reuses
//     walkForwardFolds + fitCoefficients + predictPWin + acceptCalibrationOOS)
//   • lib/scoring/weighted-score.ts → computeWeightedAnalystScore + isThinEvidence
//
// Deferred (documented, not stubbed as fake passes): the `ic`, `validation`, and
// `breakdown_veto` gates. `classify()` in lib/edges/ic.ts is not exported and
// computeEdgeIC/backtest reach the network/DB, which the harness forbids. Wiring them
// needs either an export (owned by another agent) or sealed candle IC — see draft §8.

import { fitCalibration } from "@/lib/validation/calibration";
import { computeWeightedAnalystScore, isThinEvidence, SCORE_DIMENSIONS, type DimensionRecord, type ScoreDimension } from "@/lib/scoring/weighted-score";
import type { SealedDataAccessor } from "./sealed-accessor";
import { inMemorySupabase, observationsToTables } from "./mock-supabase";

// Mirror of the calibration gate's MAX_OOS_ECE (0.1) so we can report a signed margin
// without importing a private const. If that const changes, this is REPORTING-ONLY
// (margin display); the pass/fail verdict itself comes from fitCalibration unchanged.
const MAX_OOS_ECE_FOR_MARGIN = 0.1;

export interface GateVerdict {
  passed: boolean;
  margin: number | null;
  nOos: number | null;
  ece: number | null;
  detail: Record<string, unknown>;
}

// Calibration OOS gate (cohort-level model). Feeds the sealed observation set to the
// real fitCalibration via an in-memory read-only Supabase shim. The verdict is
// literally fit.oos.accepted — the same fail-closed gate that guards live sizing.
export async function evalCalibrationGate(
  accessor: SealedDataAccessor,
  market: "us" | "india",
  horizonDays: 2 | 5 | 10 | 20
): Promise<GateVerdict> {
  const observations = accessor.sealedObservations(); // throws on any future leak
  const tables = observationsToTables(observations);
  const supabase = inMemorySupabase(tables);
  const fit = await fitCalibration(supabase, market, horizonDays);

  if (!fit) {
    // fitCalibration returns null below 60 rows — "not enough matured history yet".
    return {
      passed: false,
      margin: null,
      nOos: null,
      ece: null,
      detail: { reason: "insufficient_data(<60)", nObservations: observations.length },
    };
  }
  const { accepted, ece, nOOS, reason } = fit.oos;
  const margin = ece == null ? null : MAX_OOS_ECE_FOR_MARGIN - ece; // + = clears ECE ceiling
  return {
    passed: accepted,
    margin,
    nOos: nOOS,
    ece,
    detail: { reason, nObservations: fit.nObservations },
  };
}

// Thin-evidence gate (per-symbol). Reuses computeWeightedAnalystScore + isThinEvidence
// on the symbol's sealed dimension scores. "passed" = a non-thin, real directional
// score (>=2 usable dimensions). Abstain (thin) reports passed=false — honest, not a
// fabricated low score.
export function evalThinEvidenceGate(
  scores: Partial<DimensionRecord<number>>,
  included: Partial<DimensionRecord<boolean>>,
  baseWeights: DimensionRecord<number>
): GateVerdict {
  const fullScores = fill(scores, 50);
  const fullIncluded = fillBool(included);
  const result = computeWeightedAnalystScore(fullScores, fullIncluded, baseWeights);
  const thin = isThinEvidence(result.includedDims);
  return {
    passed: !thin,
    margin: result.includedDims.length - 2, // usable dims beyond the floor of 2
    nOos: null,
    ece: null,
    detail: {
      includedDims: result.includedDims,
      abstain: result.abstain,
      score: result.score,
      renormalized: result.renormalized,
    },
  };
}

function fill(partial: Partial<DimensionRecord<number>>, dflt: number): DimensionRecord<number> {
  const out = {} as DimensionRecord<number>;
  for (const d of SCORE_DIMENSIONS as ScoreDimension[]) out[d] = partial[d] ?? dflt;
  return out;
}
function fillBool(partial: Partial<DimensionRecord<boolean>>): DimensionRecord<boolean> {
  const out = {} as DimensionRecord<boolean>;
  for (const d of SCORE_DIMENSIONS as ScoreDimension[]) out[d] = partial[d] ?? false;
  return out;
}

// Equal-weight base split used when a caller doesn't supply configured weights.
export const EQUAL_BASE_WEIGHTS: DimensionRecord<number> = {
  fundamental: 0.2,
  technical: 0.2,
  sentiment: 0.2,
  macro: 0.2,
  insider: 0.2,
};
