import type { Market } from "@/lib/edges/types";

export type EdgeProvenanceMode =
  | "prospective_capture"
  | "retrospective_reconstruction"
  | "legacy_unverified";

export const EDGE_EVIDENCE_QUALITY = "retrospective_current_universe";

export function provenanceMode(hasExplicitHistoricalRange: boolean): EdgeProvenanceMode {
  return hasExplicitHistoricalRange ? "retrospective_reconstruction" : "prospective_capture";
}

export function neweyWestLag(horizonSessions: number, sampleStepSessions: number): number {
  if (!Number.isFinite(horizonSessions) || horizonSessions < 1) return 1;
  if (!Number.isFinite(sampleStepSessions) || sampleStepSessions < 1) return Math.ceil(horizonSessions);
  return Math.max(1, Math.ceil(horizonSessions / sampleStepSessions));
}

export function edgeHealthKey(kind: "scout" | "ic", market: Market): string {
  return `cron-failed:kairos-edge-${kind}-${market}`;
}

export function inputFingerprint(input: {
  market: Market;
  symbol: string;
  date: string;
  edgeId: string;
  source: string;
  rawValue: number | null;
}): string {
  const basis = [
    input.market,
    input.symbol.toUpperCase(),
    input.date,
    input.edgeId,
    input.source,
    input.rawValue == null ? "null" : input.rawValue.toPrecision(12),
  ].join("|");
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < basis.length; i++) h1 = ((h1 << 5) + h1 + basis.charCodeAt(i)) | 0;
  for (let i = basis.length - 1; i >= 0; i--) h2 = ((h2 << 5) + h2 + basis.charCodeAt(i)) | 0;
  return `e${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}

export function universeFingerprint(market: Market, symbols: string[]): string {
  const normalized = [...new Set(symbols.map(s => s.trim().toUpperCase()).filter(Boolean))].sort();
  const basis = `${market}|${normalized.join(",")}`;
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}
