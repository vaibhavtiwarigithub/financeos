// Replay cursor (draft §4B/§6) — steps an as-of cursor forward one date at a time,
// re-seals to each date, and runs the REUSED gates. Emits one EligibilityEvent per
// (scope, as-of, gate). OFF by default — invoked explicitly, never by a cron.
//
// Two layers of time-safety, exactly as the draft requires:
//   1. OUTER sealed cursor — freezeObservationsAsOf drops anything whose label is not
//      yet knowable at asOf; the SealedDataAccessor then THROWS on any leak.
//   2. INNER purge/embargo — walkForwardFolds (inside the reused fitCalibration) keeps
//      no train label window bleeding into a test fold.

import type { LabeledObservation } from "@/lib/learning/dataset";
import type { DimensionRecord } from "@/lib/scoring/weighted-score";
import { SealedDataAccessor } from "./sealed-accessor";
import { freezeObservationsAsOf } from "./packet-assembler";
import { evalCalibrationGate, evalThinEvidenceGate, EQUAL_BASE_WEIGHTS } from "./gates";
import type { EligibilityEvent, ReplayPacketItem } from "./types";

// Per-symbol dimension inputs the harness knows at each as-of. Each entry carries the
// as-of date it applies to; the cursor uses the latest one knowable at the step date.
export interface DatedDimensionSnapshot {
  asOf: string;
  scores: Partial<DimensionRecord<number>>;
  included: Partial<DimensionRecord<boolean>>;
}

export interface CohortReplayInput {
  cohort: string;
  market: "us" | "india";
  horizonDays: 2 | 5 | 10 | 20;
  asOfDates: string[]; // ascending as-of cursor sequence
  // Full labeled-observation timeline for the point-in-time liquid universe. The
  // cursor re-freezes this to each asOf (only labels matured by then are visible).
  observations: LabeledObservation[];
  // Symbols we REPORT on (MU/INTC/GME…). They are a subset of the training universe.
  namedSymbols: string[];
  // Optional per-symbol dimension snapshots for the per-symbol thin-evidence gate.
  dimensionSnapshots?: Record<string, DatedDimensionSnapshot[]>;
  // Optional per-symbol frozen packet items (ohlcv/news/fundamental/universe). Passed
  // through the SealedDataAccessor purely so the leak guard covers them too.
  packetItemsBySymbol?: Record<string, ReplayPacketItem[]>;
  baseWeights?: DimensionRecord<number>;
}

export interface CohortReplayResult {
  events: EligibilityEvent[];
  codeNote: string;
}

function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

// Run the cohort across its as-of window. Returns the per-date gate events; the
// reporter turns them into first-eligible rows. Never writes anything.
export async function runCohortReplay(input: CohortReplayInput): Promise<CohortReplayResult> {
  const baseWeights = input.baseWeights ?? EQUAL_BASE_WEIGHTS;
  const events: EligibilityEvent[] = [];

  for (const asOf of input.asOfDates) {
    const cursor = dateOf(asOf);

    // OUTER seal: only labels matured by this as-of are visible. The accessor then
    // validates (throws) — a belt-and-suspenders guard over the freeze.
    const sealedObs = freezeObservationsAsOf(input.observations, cursor, input.horizonDays);
    const items = collectItems(input.packetItemsBySymbol, cursor);
    const accessor = new SealedDataAccessor(cursor, { observations: sealedObs, items });

    // Cohort-level calibration gate (reuses fitCalibration → acceptCalibrationOOS).
    const cal = await evalCalibrationGate(accessor, input.market, input.horizonDays);
    events.push({
      scope: input.cohort,
      asOf: cursor,
      gate: "calibration_oos",
      passed: cal.passed,
      margin: cal.margin,
      nOos: cal.nOos,
      ece: cal.ece,
      detail: cal.detail,
    });

    // Per-symbol thin-evidence gate (reuses computeWeightedAnalystScore).
    for (const sym of input.namedSymbols) {
      const snap = latestSnapshotAsOf(input.dimensionSnapshots?.[sym], cursor);
      if (!snap) continue;
      const thin = evalThinEvidenceGate(snap.scores, snap.included, baseWeights);
      events.push({
        scope: sym,
        asOf: cursor,
        gate: "thin_evidence",
        passed: thin.passed,
        margin: thin.margin,
        nOos: null,
        ece: null,
        detail: thin.detail,
      });
    }
  }

  return {
    events,
    codeNote:
      "gates reused unchanged: fitCalibration (walkForwardFolds+acceptCalibrationOOS), " +
      "computeWeightedAnalystScore+isThinEvidence. ic/validation/breakdown_veto deferred (draft §8).",
  };
}

function latestSnapshotAsOf(
  snaps: DatedDimensionSnapshot[] | undefined,
  asOf: string
): DatedDimensionSnapshot | null {
  if (!snaps?.length) return null;
  const eligible = snaps.filter((s) => dateOf(s.asOf) <= asOf).sort((a, b) => a.asOf.localeCompare(b.asOf));
  return eligible.length ? eligible[eligible.length - 1] : null;
}

// Pre-filter items to those knowable at the cursor (assembler's job); the accessor
// still validates. Kept as a plain filter here so the leak guard, not this helper,
// is what enforces the invariant.
function collectItems(
  bySymbol: Record<string, ReplayPacketItem[]> | undefined,
  asOf: string
): ReplayPacketItem[] {
  if (!bySymbol) return [];
  const out: ReplayPacketItem[] = [];
  for (const items of Object.values(bySymbol)) {
    for (const it of items) if (dateOf(it.knowableAt) <= asOf) out.push(it);
  }
  return out;
}
