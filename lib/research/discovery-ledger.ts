import type { SymbolEntry } from "@/lib/research-agent";

export type DiscoverySnapshotMember = {
  universe_snapshot_id: number;
  market: "us" | "india";
  symbol: string;
  discovery_source: string;
  is_held: boolean;
  is_etf: boolean;
  asset_class: string | null;
  screener_bucket: string | null;
};

// Records batch admission only. Decision observations and stage events remain
// the canonical records of scores and downstream decisions.
export function buildDiscoverySnapshotMembers(
  universeSnapshotId: number,
  market: "us" | "india",
  entries: SymbolEntry[],
): DiscoverySnapshotMember[] {
  const members = new Map<string, DiscoverySnapshotMember>();
  for (const entry of entries) {
    const symbol = entry.symbol.trim().toUpperCase();
    if (!symbol || members.has(symbol)) continue;
    members.set(symbol, {
      universe_snapshot_id: universeSnapshotId,
      market,
      symbol,
      discovery_source: entry.discovery_source ?? "watchlist",
      is_held: entry.isHeld,
      is_etf: entry.isEtf,
      asset_class: entry.assetClass ?? null,
      screener_bucket: entry.screenerBucket ?? null,
    });
  }
  return [...members.values()];
}
