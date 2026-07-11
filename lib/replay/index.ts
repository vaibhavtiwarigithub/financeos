// Historical Replay Harness — public surface (draft §4).
//
// OFF by default. This module exports no cron, no route, no scheduled entry point —
// it is an explicitly-invoked, offline, measure-only harness. It touches no order or
// money path, promotes/demotes no model, and re-fetches nothing on replay.

export * from "./types";
export { SealedDataAccessor, FutureDataLeakError } from "./sealed-accessor";
export {
  assemblePacket,
  freezeObservationsAsOf,
  withKnowableAt,
  DEFAULT_FUNDAMENTAL_LAG_DAYS,
  type RawRecord,
  type AssemblePacketArgs,
  type AssembleResult,
} from "./packet-assembler";
export { evalCalibrationGate, evalThinEvidenceGate, EQUAL_BASE_WEIGHTS, type GateVerdict } from "./gates";
export { runCohortReplay, type CohortReplayInput, type CohortReplayResult, type DatedDimensionSnapshot } from "./cursor";
export { buildEligibilityReport, renderReportTable, type ForwardReturnLookup } from "./reporter";
export { inMemorySupabase, observationsToTables } from "./mock-supabase";
