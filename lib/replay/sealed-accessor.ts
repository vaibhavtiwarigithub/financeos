// Sealed replay cursor — the leak-prevention mechanism (draft §4B).
//
// A SealedDataAccessor is bound to a single `asOf` cursor. Every read goes through
// it, and it THROWS (does not silently filter) if it is asked for, or handed, any
// record whose knowable-date is AFTER `asOf`. A throw turns a latent packet-assembly
// leak into a loud, testable failure — exactly what test 14 asserts.
//
// It has NO network client. The only way data gets in is a pre-frozen packet passed
// to the constructor, which structurally forecloses the `today`-keyed live-cache leak
// (lib/data/provider-fetch.ts) because the live fetch path is simply unreachable here.

import type { LabeledObservation } from "@/lib/learning/dataset";
import type { ReplayPacketItem, ReplayItemType, SealedObservation } from "./types";

// Thrown when a record dated after the as-of cursor reaches the accessor. Named so
// tests can assert `instanceof FutureDataLeakError`.
export class FutureDataLeakError extends Error {
  readonly asOf: string;
  readonly itemType: string;
  readonly symbol: string | undefined;
  readonly knowableAt: string;
  constructor(asOf: string, rec: { itemType: string; symbol?: string; knowableAt: string }) {
    super(
      `FutureDataLeakError: ${rec.itemType}${rec.symbol ? ` (${rec.symbol})` : ""} ` +
        `knowable_at=${rec.knowableAt} is AFTER as-of cursor ${asOf} — a packet leaked future data.`
    );
    this.name = "FutureDataLeakError";
    this.asOf = asOf;
    this.itemType = rec.itemType;
    this.symbol = rec.symbol;
    this.knowableAt = rec.knowableAt;
  }
}

// Compare only the calendar-date portion. A record published at any time ON the as-of
// date is knowable (end-of-day); one dated the next day is a leak. ISO YYYY-MM-DD
// strings sort lexicographically, so string compare is correct and TZ-stable.
function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

export interface SealedInput {
  items?: ReplayPacketItem[];
  observations?: SealedObservation[];
}

export class SealedDataAccessor {
  readonly asOf: string;
  private readonly items: ReplayPacketItem[];
  private readonly observations: SealedObservation[];

  constructor(asOf: string, input: SealedInput = {}) {
    this.asOf = dateOf(asOf);
    this.items = input.items ?? [];
    this.observations = input.observations ?? [];
  }

  // The single invariant. Every returned record passes through here. A violation
  // aborts the run rather than being quietly dropped.
  private assertSealed(rec: { itemType: string; symbol?: string; knowableAt: string }): void {
    if (dateOf(rec.knowableAt) > this.asOf) {
      throw new FutureDataLeakError(this.asOf, rec);
    }
  }

  // ── Packet-item reads (each asserts every item it returns) ──────────────────
  private read(type?: ReplayItemType, symbol?: string): ReplayPacketItem[] {
    const out: ReplayPacketItem[] = [];
    for (const it of this.items) {
      if (type && it.itemType !== type) continue;
      if (symbol && it.symbol !== symbol) continue;
      this.assertSealed(it); // throws on any future-stamped item — never filtered
      out.push(it);
    }
    return out;
  }

  prices(symbol?: string): ReplayPacketItem[] {
    return this.read("ohlcv", symbol).sort((a, b) => a.knowableAt.localeCompare(b.knowableAt));
  }
  fundamentals(symbol?: string): ReplayPacketItem[] {
    return this.read("fundamental", symbol).sort((a, b) => a.knowableAt.localeCompare(b.knowableAt));
  }
  news(symbol?: string): ReplayPacketItem[] {
    return this.read("news", symbol);
  }
  universe(): ReplayPacketItem[] {
    return this.read("universe");
  }
  macro(seriesId?: string): ReplayPacketItem[] {
    return this.read("macro", seriesId).sort((a, b) => a.knowableAt.localeCompare(b.knowableAt));
  }
  corporateActions(symbol?: string): ReplayPacketItem[] {
    return this.read("corporate_action", symbol).sort((a, b) => a.knowableAt.localeCompare(b.knowableAt));
  }
  allItems(): ReplayPacketItem[] {
    return this.read();
  }

  // ── Labeled-observation feed (the calibration gate's sealed training set) ────
  // Asserts every observation is knowable at asOf, then returns the raw
  // LabeledObservation objects so the REUSED gate functions consume them unchanged.
  sealedObservations(): LabeledObservation[] {
    const out: LabeledObservation[] = [];
    for (const so of this.observations) {
      this.assertSealed({ itemType: "observation", symbol: so.observation.symbol, knowableAt: so.knowableAt });
      out.push(so.observation);
    }
    return out;
  }
}
