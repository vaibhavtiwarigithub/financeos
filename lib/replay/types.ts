// Historical Replay Harness — shared types.
//
// See features/historical-replay-harness/FEATURE_ARCHITECTURE.md. This harness is
// OFF by default: it is an explicitly-invoked, offline, measure-only tool. Nothing
// here runs in a cron or the money path. It answers ONE question per model:
// "when would this model FIRST have become eligible?" — with the answer chosen by
// the real gates, never by a human who already knows the outcome.

import type { LabeledObservation } from "@/lib/learning/dataset";

// The four packet input categories (mirrors the proposed replay_packet_items.item_type).
export type ReplayItemType =
  | "ohlcv"
  | "fundamental"
  | "news"
  | "universe"
  | "macro"
  | "corporate_action";

// A single frozen input inside a packet. `knowableAt` is the date this record was
// PUBLIC — the sealed accessor enforces knowableAt <= asOf on every read.
export interface ReplayPacketItem {
  itemType: ReplayItemType;
  symbol: string;
  knowableAt: string; // ISO date/timestamp — when this datum became public knowledge
  source?: string;
  sourceTier?: number;
  payload: unknown;
  payloadHash: string; // sha256 of the payload — makes the freeze auditable
}

// One symbol × one as-of date × the full set of scoring inputs, each stamped with
// the date it was knowable. Immutable once assembled (deep-frozen).
export interface ReplayPacket {
  cohort: string;
  symbol: string;
  market: "us" | "india";
  asOf: string; // YYYY-MM-DD
  items: ReplayPacketItem[];
  manifestHash: string; // sha256 over the frozen item set — proves inputs didn't move
  publicationLagAssumptions: Record<string, unknown>;
  createdAt: string;
}

// A labeled observation carried through the replay. `knowableAt` is when the LABEL
// matured (decision ts + horizon) — you cannot train on a label you couldn't yet
// have observed. This is the sealing key for the calibration gate's training set.
export interface SealedObservation {
  knowableAt: string;
  observation: LabeledObservation;
}

// Which reused gate produced a verdict. `ic` / `validation` / `breakdown_veto` are
// listed for the schema but deferred in code (see README of this module / draft §8).
export type ReplayGate =
  | "calibration_oos"
  | "thin_evidence"
  | "ic"
  | "validation"
  | "breakdown_veto";

// One per (symbol|cohort, as-of, gate) — the per-date verdict the reporter walks.
export interface EligibilityEvent {
  scope: string; // named symbol, or the cohort name for cohort-level (model) gates
  asOf: string;
  gate: ReplayGate;
  passed: boolean;
  margin: number | null; // signed distance past the threshold (+ = clears by this much)
  nOos: number | null;
  ece: number | null;
  detail?: Record<string, unknown>;
}

// The honest output: first date a gate flips to pass, or null ("never in window").
export interface EligibilityReportRow {
  scope: string;
  gate: ReplayGate;
  firstEligibleAsOf: string | null; // MIN(asOf WHERE passed) — gate-selected, never handpicked
  marginAtFirst: number | null;
  nOosAtFirst: number | null;
  eceAtFirst: number | null;
  // Forward return AFTER firstEligibleAsOf — a read-only CONSEQUENCE column. It is
  // never fed back into selection, sizing, or thresholds. Null when not computed or
  // when the model was never eligible.
  forwardReturnAfter: number | null;
  forwardReturnAsOf: string | null; // the strictly-later date the consequence was read at
  note?: string;
}
