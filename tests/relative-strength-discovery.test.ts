import { describe, expect, it } from "vitest";
import { rotatingLiquidOffset, selectRelativeStrengthCandidates } from "@/lib/research/relative-strength-discovery";

const rows = [
  { symbol: "AMD", date: "2026-08-01", edge_id: "rel_strength_6m", z_value: 1.4, universe_id: "us:liquid" },
  { symbol: "AMD", date: "2026-08-01", edge_id: "high_52w_proximity", z_value: 0.7, universe_id: "us:liquid" },
  { symbol: "AMD", date: "2026-08-01", edge_id: "volume_breakout", z_value: -0.2, universe_id: "us:liquid" },
  { symbol: "PANW", date: "2026-08-01", edge_id: "rel_strength_6m", z_value: 1.1, universe_id: "us:liquid" },
  { symbol: "PANW", date: "2026-08-01", edge_id: "high_52w_proximity", z_value: 0.8, universe_id: "us:liquid" },
  { symbol: "WEAK", date: "2026-08-01", edge_id: "rel_strength_6m", z_value: -0.1, universe_id: "us:liquid" },
  { symbol: "WEAK", date: "2026-08-01", edge_id: "high_52w_proximity", z_value: 2.1, universe_id: "us:liquid" },
  { symbol: "OLD", date: "2026-07-31", edge_id: "rel_strength_6m", z_value: 9, universe_id: "old" },
  { symbol: "OLD", date: "2026-07-31", edge_id: "high_52w_proximity", z_value: 9, universe_id: "old" },
];

describe("relative-strength discovery", () => {
  it("uses only fresh common-date, positive completed-session evidence", () => {
    expect(selectRelativeStrengthCandidates(rows, new Date("2026-08-02T00:00:00Z"))).toEqual([
      expect.objectContaining({ symbol: "AMD", context: expect.objectContaining({ edge_date: "2026-08-01", composite: 1.155 }) }),
      expect.objectContaining({ symbol: "PANW", context: expect.objectContaining({ edge_date: "2026-08-01", composite: 0.995 }) }),
    ]);
  });

  it("fails closed when the latest evidence is stale", () => {
    expect(selectRelativeStrengthCandidates(rows, new Date("2026-08-08T00:00:00Z"))).toEqual([]);
  });

  it("rotates bounded US liquid-universe pages deterministically", () => {
    const first = rotatingLiquidOffset("us", 50, new Date("2026-08-03T00:00:00Z"));
    const second = rotatingLiquidOffset("us", 50, new Date("2026-08-04T00:00:00Z"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(0);
    expect(first).not.toBe(second);
    expect(first % 50).toBe(0);
  });
});
