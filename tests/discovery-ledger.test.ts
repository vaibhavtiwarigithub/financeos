import { describe, expect, it } from "vitest";
import { buildDiscoverySnapshotMembers } from "@/lib/research/discovery-ledger";

describe("discovery snapshot ledger", () => {
  it("records batch admission without inventing a score or execution state", () => {
    const rows = buildDiscoverySnapshotMembers(41, "us", [
      { symbol: "msft", isHeld: false, isEtf: false, assetClass: "us_equity", discovery_source: "screener_momentum", screenerBucket: "momentum" },
      { symbol: "MSFT", isHeld: true, isEtf: false, assetClass: "us_equity", discovery_source: "holding" },
      { symbol: "IBIT", isHeld: false, isEtf: true, assetClass: "etf", discovery_source: "region_etf" },
    ]);

    expect(rows).toEqual([
      { universe_snapshot_id: 41, market: "us", symbol: "MSFT", discovery_source: "screener_momentum", is_held: false, is_etf: false, asset_class: "us_equity", screener_bucket: "momentum" },
      { universe_snapshot_id: 41, market: "us", symbol: "IBIT", discovery_source: "region_etf", is_held: false, is_etf: true, asset_class: "etf", screener_bucket: null },
    ]);
    expect(JSON.stringify(rows)).not.toContain("score");
    expect(JSON.stringify(rows)).not.toContain("eligible");
  });
});
