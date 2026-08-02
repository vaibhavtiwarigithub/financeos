import { describe, expect, it } from "vitest";
import { assessStrategyConditions, featureAuditForInstrument, instrumentFamily } from "@/lib/feature-packs/catalog";

describe("feature-pack catalog", () => {
  it("never applies company fundamentals to an ETF", () => {
    const audit = featureAuditForInstrument({ assetClass: "etf", instrumentKind: "etf" });
    expect(audit.family).toBe("etf");
    expect(audit.active.map(feature => feature.id)).not.toContain("sector_relative_pe");
    expect(audit.inapplicable.map(feature => feature.id)).toContain("sector_relative_pe");
  });

  it("classifies leveraged products before generic ETFs", () => {
    expect(instrumentFamily({ assetClass: "etf", instrumentKind: "leveraged_or_inverse_etf" })).toBe("leveraged_etf");
  });

  it("makes unsupported template conditions explicit instead of treating them as automated", () => {
    const summary = assessStrategyConditions({
      technical: { rsi_min: 60, macd_cross_up: true, volume_surge: true },
      fundamental: { gross_margin_min: 0.25, roe_min: 0.15 },
    });
    expect(summary.automated).toBe(false);
    expect(summary.scannerSupported).toContain("Rsi Min");
    expect(summary.shadowOnly).toEqual(expect.arrayContaining(["Macd Cross Up", "Gross Margin Min"]));
    expect(summary.unsupported).toContain("Volume Surge");
  });
});
