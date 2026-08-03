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
    // gross_margin_min ships in AlgoStrategy.scan_filters, so the manual Scanner
    // does evaluate it; only macd_cross_up is genuinely shadow-gated.
    expect(summary.scannerSupported).toEqual(expect.arrayContaining(["Gross Margin Min", "Roe Min"]));
    expect(summary.shadowOnly).toEqual(["Macd Cross Up"]);
    expect(summary.unsupported).toContain("Volume Surge");
  });

  it("treats an ordinary listed company as an operating company in both vocabularies", () => {
    // Journal rows carry JournalAssetType ("company"/"india_company"); live runs
    // carry InstrumentKind ("us_equity"/"india_equity"). Both must resolve.
    expect(instrumentFamily({ assetClass: "company", instrumentKind: null })).toBe("operating_company");
    expect(instrumentFamily({ assetClass: "india_company", instrumentKind: null })).toBe("operating_company");
    expect(instrumentFamily({ assetClass: "company", instrumentKind: "us_equity" })).toBe("operating_company");
    const audit = featureAuditForInstrument({ assetClass: "company", instrumentKind: null });
    expect(audit.active.map(feature => feature.id)).toContain("rsi14");
    expect(audit.inapplicable).toHaveLength(0);
  });

  it("claims nothing about applicability when the instrument was never classified", () => {
    const audit = featureAuditForInstrument({ assetClass: null, instrumentKind: null });
    expect(audit.family).toBe("unknown");
    expect(audit.active).toHaveLength(0);
    // The bug: an unclassified instrument reported every live v1 input as
    // inapplicable to a decision those inputs had actually scored.
    expect(audit.inapplicable).toHaveLength(0);
    expect(audit.measured).toHaveLength(0);
  });
});
