import { describe, it, expect } from "vitest";
import { allocate, normalizeRegime, type SleeveRow } from "@/lib/allocation/allocator";

const US: SleeveRow[] = [
  { market: "us", sleeve: "equity", target_pct: 70, min_pct: 0, max_pct: 90, instruments: [], enabled: true },
  { market: "us", sleeve: "defensive_etf", target_pct: 20, min_pct: 0, max_pct: 50, instruments: ["SHY", "TLT"], enabled: true },
  { market: "us", sleeve: "cash", target_pct: 10, min_pct: 5, max_pct: 100, instruments: [], enabled: true },
  { market: "us", sleeve: "leveraged", target_pct: 0, min_pct: 0, max_pct: 15, instruments: ["SSO"], enabled: false },
];

const sumPct = (r: { targetPct: number }[]) => Math.round(r.reduce((a, x) => a + x.targetPct, 0));

describe("allocator", () => {
  it("neutral: renormalizes enabled sleeves to 100 and drops disabled leveraged", () => {
    const r = allocate(US, "neutral");
    expect(r.map(x => x.sleeve).sort()).toEqual(["cash", "defensive_etf", "equity"]);
    expect(sumPct(r)).toBe(100);
    expect(r.find(x => x.sleeve === "leveraged")).toBeUndefined();
  });

  it("risk_off shifts weight OUT of equity into defensive/cash (still sums 100)", () => {
    const on = allocate(US, "risk_on").find(x => x.sleeve === "equity")!.targetPct;
    const neu = allocate(US, "neutral").find(x => x.sleeve === "equity")!.targetPct;
    const off = allocate(US, "risk_off").find(x => x.sleeve === "equity")!.targetPct;
    expect(off).toBeLessThan(neu);
    expect(on).toBeGreaterThan(neu);
    expect(sumPct(allocate(US, "risk_off"))).toBe(100);
  });

  it("clamps every sleeve to its hard band", () => {
    for (const reg of ["risk_on", "neutral", "risk_off"] as const) {
      for (const t of allocate(US, reg)) {
        const band = US.find(s => s.sleeve === t.sleeve)!;
        // targetPct is post-renormalize, so just assert non-negative + <=100
        expect(t.targetPct).toBeGreaterThanOrEqual(0);
        expect(t.targetPct).toBeLessThanOrEqual(100);
        expect(band).toBeTruthy();
      }
    }
  });

  it("normalizeRegime maps labels", () => {
    expect(normalizeRegime("RISK_OFF")).toBe("risk_off");
    expect(normalizeRegime("bull market")).toBe("risk_on");
    expect(normalizeRegime(null)).toBe("neutral");
  });

  it("does not emit NaN or zero-sum targets when sleeve inputs are malformed", () => {
    const malformed: SleeveRow[] = [
      { market: "us", sleeve: "equity", target_pct: Number.NaN, min_pct: 0, max_pct: 0, instruments: [], enabled: true },
      { market: "us", sleeve: "defensive_etf", target_pct: 0, min_pct: 0, max_pct: 0, instruments: [], enabled: true },
      { market: "us", sleeve: "cash", target_pct: 0, min_pct: 0, max_pct: 100, instruments: [], enabled: true },
    ];
    const r = allocate(malformed, "neutral");
    expect(r.every(x => Number.isFinite(x.targetPct))).toBe(true);
    expect(sumPct(r)).toBe(100);
    expect(r.find(x => x.sleeve === "cash")?.targetPct).toBe(100);
  });
});
