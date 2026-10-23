import { describe, expect, it } from "vitest";
import { semiconductorCapacity } from "@/lib/trading/semiconductor-risk";

const base = { nav: 10000, cash: 2000, stopDistancePct: 10, riskBudgetPct: 0.15, exposureCapPct: 20, holdings: [] };
describe("SOXL paper risk capacity", () => {
  it("halves capacity when stop distance doubles at fixed loss budget", () => {
    expect(semiconductorCapacity(base)).toMatchObject({ ok: true, maxNotional: 150 });
    expect(semiconductorCapacity({ ...base, stopDistancePct: 20 })).toMatchObject({ ok: true, maxNotional: 75 });
  });
  it("counts ARM and sector ETFs against one exposure limit", () => {
    expect(semiconductorCapacity({ ...base, holdings: [
      { symbol: "ARM", marketValue: 1000, semiconductor: null },
      { symbol: "SOXX", marketValue: 700, semiconductor: null },
    ] })).toMatchObject({ ok: true, exposureBefore: 1700, maxNotional: 100 });
  });
  it("caps notional at five percent and never uses cash as NAV", () => {
    expect(semiconductorCapacity({ ...base, riskBudgetPct: 1 })).toMatchObject({ ok: true, maxNotional: 500 });
  });
  it("refuses missing classification and invalid marks", () => {
    expect(semiconductorCapacity({ ...base, holdings: [{ symbol: "UNKNOWN", marketValue: 100, semiconductor: null }] })).toMatchObject({ ok: false });
    expect(semiconductorCapacity({ ...base, holdings: [{ symbol: "ARM", marketValue: NaN, semiconductor: true }] })).toMatchObject({ ok: false });
  });
  it("bounds unknown fund exposure instead of treating it as zero or an unknown company", () => {
    expect(semiconductorCapacity({ ...base, riskBudgetPct: 1, holdings: [
      { symbol: "JQUA", marketValue: 1500, semiconductor: null },
      { symbol: "SQQQ", marketValue: 50, semiconductor: null },
    ] })).toMatchObject({ ok: true, exposureBefore: 1650,
      conservativeFundUpperBounds: ["JQUA", "SQQQ"], maxNotional: 350 / 3 });
    expect(semiconductorCapacity({ ...base, holdings: [
      { symbol: "NEW-COMPANY", marketValue: 100, semiconductor: null },
    ] })).toMatchObject({ ok: false, reason: "unclassified_portfolio_exposure" });
  });
  it("a conservative known-fund bound can exhaust the cap and inverse notional never offsets it", () => {
    expect(semiconductorCapacity({ ...base, holdings: [
      { symbol: "JQUA", marketValue: 1800, semiconductor: null },
      { symbol: "SQQQ", marketValue: 100, semiconductor: null },
    ] })).toMatchObject({ ok: true, exposureBefore: 2100, maxNotional: 0 });
  });
  it("blocks adding to existing SOXL", () => {
    expect(semiconductorCapacity({ ...base, holdings: [{ symbol: "SOXL", marketValue: 1, semiconductor: true }] })).toMatchObject({ ok: false, reason: "existing_soxl_position" });
  });
  it("never treats an unsupported leveraged fund as an ordinary 1x fund", () => {
    expect(semiconductorCapacity({ ...base, holdings: [
      { symbol: "UPRO", marketValue: 100, semiconductor: null },
    ] })).toMatchObject({ ok: false, reason: "unclassified_leveraged_exposure" });
  });
});
