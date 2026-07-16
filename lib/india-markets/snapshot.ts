// India Markets snapshot contract + deterministic assembly.
//
// Assembles a frozen `IndiaMarketsSnapshot` (indices + NSE sector indices +
// NIFTY-50 breadth) from validated adapter quotes. Pure/assembly logic lives
// here (no network, no DB) so it is fully fixture-testable; the network fetch and
// persistence live in the adapter and the route respectively.
//
// Advisory display only — nothing here feeds scoring, sizing, or orders.

import type { AdapterQuote } from "@/lib/india-markets/adapter";
import {
  NIFTY50_UNIVERSE,
  BREADTH_COVERAGE_FLOOR,
} from "@/lib/india-markets/constituents";

export const POLICY_VERSION_ID = "india-markets-v1";

export type SnapshotStatus = "complete" | "partial" | "unavailable";
export type Quality = "fresh" | "stale";

export interface IndexRow {
  symbol: string;
  label: string;
  price: number;
  changePct: number;
  observedAt: string | null;
  source: string;
  quality: Quality;
}
export type SectorRow = IndexRow;

export interface BreadthBlock {
  universeId: "nifty_50";
  universeAsOf: string;
  eligibleN: number;
  resolvedN: number;
  advanced: number;
  declined: number;
  unchanged: number;
  unavailable: number;
  coveragePct: number;
  quality: "complete" | "partial";
}

export interface UnavailableComponent {
  component: string;
  reasonCode: string;
}

export interface IndiaMarketsSnapshot {
  market: "india";
  currency: "INR";
  asOf: string;
  fetchedAt: string;
  status: SnapshotStatus;
  policyVersionId: string;
  indices: IndexRow[];
  sectors: SectorRow[];
  breadth: BreadthBlock | null;
  unavailable: UnavailableComponent[];
}

// Index + sector universe the snapshot advertises. These are the components a
// "complete" snapshot must fully resolve. NSE index points, INR basis.
export const INDIA_INDEX_META: { symbol: string; label: string }[] = [
  { symbol: "^NSEI", label: "NIFTY 50" },
  { symbol: "^BSESN", label: "SENSEX" },
  { symbol: "^NSEBANK", label: "BANK NIFTY" },
  { symbol: "^INDIAVIX", label: "India VIX" },
];

export const INDIA_SECTOR_META: { symbol: string; label: string }[] = [
  { symbol: "^CNXIT", label: "IT" },
  { symbol: "^NSEBANK", label: "Bank" },
  { symbol: "^CNXAUTO", label: "Auto" },
  { symbol: "^CNXFMCG", label: "FMCG" },
  { symbol: "^CNXPHARMA", label: "Pharma" },
  { symbol: "^CNXMETAL", label: "Metal" },
  { symbol: "^CNXENERGY", label: "Energy" },
  { symbol: "^CNXREALTY", label: "Realty" },
  { symbol: "^CNXFIN", label: "Financials" },
  { symbol: "^CNXINFRA", label: "Infra" },
];

export const INDEX_SYMBOLS = INDIA_INDEX_META.map((m) => m.symbol);
export const SECTOR_SYMBOLS = INDIA_SECTOR_META.map((m) => m.symbol);

// Derive an India session date (YYYY-MM-DD, IST) from the freshest observation,
// falling back to "now" in IST. Deterministic given inputs.
function indiaSessionDate(observedAts: (string | null)[], nowIso: string): string {
  const newest = observedAts
    .filter((v): v is string => !!v)
    .sort()
    .pop();
  const iso = newest ?? nowIso;
  // IST is UTC+5:30 — shift then take the date part.
  const ms = new Date(iso).getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function assembleRows(
  meta: { symbol: string; label: string }[],
  quotes: Map<string, AdapterQuote>,
  component: string,
): { rows: IndexRow[]; missing: UnavailableComponent[] } {
  const rows: IndexRow[] = [];
  const missing: UnavailableComponent[] = [];
  for (const m of meta) {
    const q = quotes.get(m.symbol);
    if (q && q.ok && q.price != null && q.changePct != null) {
      rows.push({
        symbol: m.symbol,
        label: m.label,
        price: q.price,
        changePct: q.changePct,
        observedAt: q.observedAt,
        source: q.source,
        quality: q.quality,
      });
    } else {
      missing.push({ component: `${component}:${m.symbol}`, reasonCode: q?.reasonCode ?? "no_data" });
    }
  }
  return { rows, missing };
}

/**
 * Compute NIFTY-50 breadth from constituent quotes. Advanced/declined/unchanged
 * are counted only over RESOLVED names; unresolved names stay in the coverage
 * denominator (reported as `unavailable`) so a thin fetch can never masquerade as
 * healthy breadth. Below the coverage floor the block is labeled "partial".
 */
export function computeBreadth(quotes: AdapterQuote[]): BreadthBlock {
  const eligibleN = NIFTY50_UNIVERSE.symbols.length;
  const eligible = new Set(NIFTY50_UNIVERSE.symbols);
  const seen = new Set<string>();
  let advanced = 0, declined = 0, unchanged = 0, resolvedN = 0;
  for (const q of quotes) {
    if (!eligible.has(q.symbol) || seen.has(q.symbol)) continue;
    seen.add(q.symbol);
    if (!q.ok || q.changePct == null) continue;
    resolvedN += 1;
    if (q.changePct > 0) advanced += 1;
    else if (q.changePct < 0) declined += 1;
    else unchanged += 1;
  }
  const unavailable = Math.max(0, eligibleN - resolvedN);
  const coveragePct = eligibleN > 0 ? Math.round((resolvedN / eligibleN) * 1000) / 10 : 0;
  const quality: "complete" | "partial" =
    resolvedN / Math.max(1, eligibleN) >= BREADTH_COVERAGE_FLOOR ? "complete" : "partial";
  return {
    universeId: NIFTY50_UNIVERSE.universeId,
    universeAsOf: NIFTY50_UNIVERSE.universeAsOf,
    eligibleN,
    resolvedN,
    advanced,
    declined,
    unchanged,
    unavailable,
    coveragePct,
    quality,
  };
}

export interface BuildInput {
  indexQuotes: AdapterQuote[];
  sectorQuotes: AdapterQuote[];
  breadth?: BreadthBlock | null; // may be carried forward from a prior fill
  breadthUnavailableReason?: string; // when breadth is null on this path
  now?: string; // ISO, injectable for tests
}

/**
 * PURE: assemble the frozen snapshot from validated quotes. Status is honest:
 *   - unavailable: no index rows resolved at all.
 *   - complete: every index + sector resolved AND breadth present & "complete".
 *   - partial: anything in between (renders available rows + explicit coverage).
 */
export function buildSnapshot(input: BuildInput): IndiaMarketsSnapshot {
  const now = input.now ?? new Date().toISOString();
  const indexMap = new Map(input.indexQuotes.map((q) => [q.symbol, q]));
  const sectorMap = new Map(input.sectorQuotes.map((q) => [q.symbol, q]));

  const { rows: indices, missing: idxMissing } = assembleRows(INDIA_INDEX_META, indexMap, "index");
  const { rows: sectors, missing: secMissing } = assembleRows(INDIA_SECTOR_META, sectorMap, "sector");

  const unavailable: UnavailableComponent[] = [...idxMissing, ...secMissing];

  const breadth = input.breadth ?? null;
  if (!breadth) {
    unavailable.push({
      component: "breadth",
      reasonCode: input.breadthUnavailableReason ?? "awaiting_scheduled_fill",
    });
  } else if (breadth.quality === "partial") {
    unavailable.push({ component: "breadth", reasonCode: "below_coverage_floor" });
  }

  const asOf = indiaSessionDate(indices.map((r) => r.observedAt), now);

  let status: SnapshotStatus;
  if (indices.length === 0) {
    status = "unavailable";
  } else if (
    indices.length === INDIA_INDEX_META.length &&
    sectors.length === INDIA_SECTOR_META.length &&
    breadth != null &&
    breadth.quality === "complete"
  ) {
    status = "complete";
  } else {
    status = "partial";
  }

  return {
    market: "india",
    currency: "INR",
    asOf,
    fetchedAt: now,
    status,
    policyVersionId: POLICY_VERSION_ID,
    indices,
    sectors,
    breadth,
    unavailable,
  };
}
