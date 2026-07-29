// Packet assembler (draft §4A) — OFFLINE and PURE. No network client here.
//
// It takes already-fetched raw records (from local fixtures, or from a caller that
// did its own throttled one-time historical pull) and FREEZES them into an immutable
// per-(symbol, as-of) packet, computing each record's `knowableAt` per the freezing
// rules and dropping anything not yet public at the as-of date. Assembly is the ONLY
// place filtering happens — after this, the SealedDataAccessor validates (throws) so a
// mis-stamp is loud, not silent.
//
// The assembler NEVER reaches a provider. Handing it raws is the caller's job; this
// keeps the harness a pure function of frozen inputs + gate code, byte-for-byte
// reproducible via the manifest hash (matching fitAndStoreCalibration's dataset_hash).

import crypto from "crypto";
import type { LabeledObservation } from "@/lib/learning/dataset";
import type { ReplayItemType, ReplayPacket, ReplayPacketItem, SealedObservation } from "./types";

// Conservative default publication lag (days) applied to a fundamental when the
// provider gives only a fiscal period end and no filing/acceptance date. A Q4 result
// for period ending Dec 31 is not public until the ~Feb filing — draft §4A.
export const DEFAULT_FUNDAMENTAL_LAG_DAYS = 60;

// A raw, un-frozen input record. Depending on itemType, different date fields are
// used to derive `knowableAt` (see deriveKnowableAt).
export interface RawRecord {
  itemType: ReplayItemType;
  symbol: string;
  source?: string;
  sourceTier?: number;
  payload: unknown;
  // ohlcv: the candle's own date (known at that day's close)
  date?: string;
  // news: publication timestamp
  publishedAt?: string;
  // fundamental: filing/acceptance date (preferred) …
  filedAt?: string;
  // … or, if no filing date, the fiscal period end (a lag is then applied)
  periodEnd?: string;
  // universe: the snapshot observation date
  observedAt?: string;
  // macro: first day this vintage was publicly available
  realtimeStart?: string;
  // corporate action: announcement timestamp, or ex-date as conservative fallback
  announcedAt?: string;
  exDate?: string;
}

function sha256(v: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface AssembleResult {
  packet: ReplayPacket;
  // Records that were EXCLUDED because they were not yet public at as-of. Returned
  // for auditing the freeze; never enter the packet.
  excluded: { record: RawRecord; knowableAt: string }[];
}

// Derive when a raw record became public. Returns { knowableAt, assumedLag? }.
function deriveKnowableAt(
  r: RawRecord,
  lagDays: number
): { knowableAt: string; assumedLagDays?: number } {
  switch (r.itemType) {
    case "ohlcv":
      if (!r.date) throw new Error("ohlcv raw record requires `date`");
      return { knowableAt: r.date };
    case "news":
      if (!r.publishedAt) throw new Error("news raw record requires `publishedAt`");
      return { knowableAt: r.publishedAt };
    case "universe":
      if (!r.observedAt) throw new Error("universe raw record requires `observedAt`");
      return { knowableAt: r.observedAt };
    case "macro":
      if (!r.realtimeStart) throw new Error("macro raw record requires `realtimeStart`");
      return { knowableAt: r.realtimeStart };
    case "corporate_action":
      if (r.announcedAt) return { knowableAt: r.announcedAt };
      if (r.exDate) return { knowableAt: r.exDate };
      throw new Error("corporate_action raw record requires `announcedAt` or `exDate`");
    case "fundamental":
      if (r.filedAt) return { knowableAt: r.filedAt };
      if (r.periodEnd) return { knowableAt: addDays(r.periodEnd, lagDays), assumedLagDays: lagDays };
      throw new Error("fundamental raw record requires `filedAt` or `periodEnd`");
    default:
      throw new Error(`unknown itemType ${(r as RawRecord).itemType}`);
  }
}

function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

// Deep-freeze so a frozen packet cannot be mutated after assembly (immutability
// discipline from draft §4A). Shallow payloads are frozen; nested objects too.
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

export interface AssemblePacketArgs {
  cohort: string;
  symbol: string;
  market: "us" | "india";
  asOf: string; // YYYY-MM-DD
  raws: RawRecord[];
  fundamentalLagDays?: number;
}

// Freeze one packet: derive knowableAt for every raw, keep only those public at asOf,
// hash each payload, hash the manifest, deep-freeze. Immutable after return.
export function assemblePacket(args: AssemblePacketArgs): AssembleResult {
  const lagDays = args.fundamentalLagDays ?? DEFAULT_FUNDAMENTAL_LAG_DAYS;
  const asOf = dateOf(args.asOf);
  const items: ReplayPacketItem[] = [];
  const excluded: AssembleResult["excluded"] = [];
  const lagApplied: string[] = [];

  for (const r of args.raws) {
    const { knowableAt, assumedLagDays } = deriveKnowableAt(r, lagDays);
    if (dateOf(knowableAt) > asOf) {
      excluded.push({ record: r, knowableAt });
      continue;
    }
    if (assumedLagDays != null) {
      lagApplied.push(`${r.symbol}:${r.periodEnd}→${knowableAt}(+${assumedLagDays}d)`);
    }
    items.push({
      itemType: r.itemType,
      symbol: r.symbol,
      knowableAt,
      source: r.source,
      sourceTier: r.sourceTier,
      payload: r.payload,
      payloadHash: sha256(r.payload),
    });
  }

  items.sort((a, b) => a.knowableAt.localeCompare(b.knowableAt) || a.itemType.localeCompare(b.itemType));

  const publicationLagAssumptions: Record<string, unknown> =
    lagApplied.length > 0
      ? { fundamentalLagDays: lagDays, appliedTo: lagApplied }
      : {};

  const manifestHash = sha256({
    cohort: args.cohort,
    symbol: args.symbol,
    market: args.market,
    asOf,
    items: items.map((i) => [i.itemType, i.symbol, i.knowableAt, i.payloadHash]),
    publicationLagAssumptions,
  });

  const packet: ReplayPacket = {
    cohort: args.cohort,
    symbol: args.symbol,
    market: args.market,
    asOf,
    items,
    manifestHash,
    publicationLagAssumptions,
    createdAt: new Date().toISOString(),
  };

  return { packet: deepFreeze(packet), excluded };
}

// ── Labeled-observation freezing ────────────────────────────────────────────
// An observation's LABEL matures `horizonDays` after its decision ts; you cannot
// train on a label you couldn't have observed yet. `knowableAt = ts + horizonDays`.
// Filtering to knowableAt <= asOf is what makes "first eligible" emerge from data
// accumulation (a data-selected date), not from a handpicked outcome date.
export function freezeObservationsAsOf(
  observations: LabeledObservation[],
  asOf: string,
  horizonDays: number
): SealedObservation[] {
  const cursor = dateOf(asOf);
  const out: SealedObservation[] = [];
  for (const o of observations) {
    const knowableAt = addDays(o.ts, horizonDays);
    if (dateOf(knowableAt) <= cursor) out.push({ knowableAt, observation: o });
  }
  return out;
}

// Convenience: build the full knowable timeline (no filtering) so a caller can hand
// it to the cursor, which re-freezes per as-of step.
export function withKnowableAt(
  observations: LabeledObservation[],
  horizonDays: number
): SealedObservation[] {
  return observations.map((o) => ({ knowableAt: addDays(o.ts, horizonDays), observation: o }));
}
