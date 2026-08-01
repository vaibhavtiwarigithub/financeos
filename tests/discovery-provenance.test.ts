import { describe, expect, it } from "vitest";
import { discoveryProvenanceItems, discoverySelectionReason } from "@/lib/research/discovery-provenance";

describe("discovery provenance", () => {
  it("formats only persisted relative-strength admission facts", () => {
    expect(discoveryProvenanceItems("edge_relative_strength", {
      relative_strength_z: 1.234,
      high_52w_proximity_z: 0.5,
      volume_breakout_z: null,
      composite: 0.977,
      edge_date: "2026-08-01",
      ignored: "not displayed",
    })).toEqual([
      { label: "6m relative strength", value: "+1.23 z" },
      { label: "52-week-high proximity", value: "+0.50 z" },
      { label: "Admission composite", value: "0.98" },
      { label: "Completed session", value: "2026-08-01" },
    ]);
  });

  it("does not invent evidence for other discovery sources", () => {
    expect(discoveryProvenanceItems("watchlist", { relative_strength_z: 8 })).toEqual([]);
    expect(discoverySelectionReason("edge_relative_strength", false)).toContain("not added to the score");
  });
});
