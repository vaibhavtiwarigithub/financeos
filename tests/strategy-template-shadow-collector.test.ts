import { describe, expect, it } from "vitest";
import { collectTemplateShadowEvidence, priceBasisForResearchSource } from "@/lib/strategy-replay/template-shadow-collector";

const config = {
  id: "cfg-1", strategy_version_id: 7, rule_version: "template-rule-compiler-v2",
  rule_spec: { market: "us", universe: ["ABC"], horizonSessions: 2 },
};

function service(configs: unknown[]) {
  return { from: () => {
    const query: any = {
      select: () => query,
      eq: () => query,
      limit: async () => ({ data: configs, error: null }),
    };
    return query;
  } };
}

describe("strategy template shadow collection", () => {
  it("maps only registered research sources to an explicit price basis", () => {
    expect(priceBasisForResearchSource("yahoo")).toBe("adjusted");
    expect(priceBasisForResearchSource("UPSTOX")).toBe("raw");
    expect(priceBasisForResearchSource("unknown-provider")).toBe("unknown");
  });

  it("does not fail research when no forward shadow is active", async () => {
    const result = await collectTemplateShadowEvidence({
      supabase: service([]), market: "us", symbol: "ABC", candles: [], source: "unknown-provider",
      observationId: null, baselineEntryEligible: false,
    });
    expect(result).toMatchObject({ activeConfigs: 0, decisionsInserted: 0, outcomesInserted: 0 });
  });

  it("surfaces unknown price provenance for an active matching shadow", async () => {
    await expect(collectTemplateShadowEvidence({
      supabase: service([config]), market: "us", symbol: "ABC", candles: [], source: "unknown-provider",
      observationId: null, baselineEntryEligible: false,
    })).rejects.toThrow("no approved price basis");
  });

  it("surfaces malformed completed bars instead of silently losing shadow observations", async () => {
    const invalid = [
      { date: "2026-10-29", open: 10, high: 9, low: 8, close: 8.5, volume: 100 },
      { date: "2026-10-30", open: 9, high: 9.5, low: 8.5, close: 9.25, volume: 100 },
    ];
    await expect(collectTemplateShadowEvidence({
      supabase: service([config]), market: "us", symbol: "ABC", candles: invalid, source: "yahoo",
      observationId: null, baselineEntryEligible: false,
    })).rejects.toThrow("invalid completed candles");
  });
});
