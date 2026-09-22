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
  it("blocks adding to existing SOXL", () => {
    expect(semiconductorCapacity({ ...base, holdings: [{ symbol: "SOXL", marketValue: 1, semiconductor: true }] })).toMatchObject({ ok: false, reason: "existing_soxl_position" });
  });
});
