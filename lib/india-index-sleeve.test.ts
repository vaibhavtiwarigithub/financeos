import { describe, expect, it } from "vitest";
import { bookVsEtf, extendBlend, pathMetrics, sleeveEvidenceState, type SleeveRow } from "@/lib/india-index-sleeve";

const d = (i: number) => new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10);
const book = (navs: number[]) => navs.map((nav, i) => ({ date: d(i), nav }));
const etf = (closes: number[]) => new Map(closes.map((c, i) => [d(i), c] as const));

describe("india index sleeve shadow", () => {
  it("seeds at the book NAV and compounds the weighted return of ETF and book", () => {
    const rows = extendBlend(book([1000, 1010, 1000]), etf([100, 102, 99]), 0.2, null);
    expect(rows).toHaveLength(3);
    expect(rows[0].blended_nav).toBe(1000);
    const r1 = 0.2 * (102 / 100 - 1) + 0.8 * (1010 / 1000 - 1);
    expect(rows[1].blended_nav).toBeCloseTo(1000 * (1 + r1), 6);
    expect(rows[2].blended_nav).toBeCloseTo(rows[1].blended_nav * (1 + 0.2 * (99 / 102 - 1) + 0.8 * (1000 / 1010 - 1)), 6);
  });
  it("weight 0 reproduces the book and weight 1 reproduces the ETF path", () => {
    const b = book([1000, 1020, 990, 1030]); const e = etf([50, 51, 49, 52]);
    const zero = extendBlend(b, e, 0, null);
    zero.forEach((r, i) => expect(r.blended_nav).toBeCloseTo(b[i].nav, 6));
    const full = extendBlend(b, e, 1, null);
    expect(full[3].blended_nav / full[0].blended_nav).toBeCloseTo(52 / 50, 6);
  });
  it("extends from the last stored row without recomputing history", () => {
    const b = book([1000, 1010, 1020, 1030]); const e = etf([100, 101, 102, 103]);
    const all = extendBlend(b, e, 0.3, null);
    const resumed = extendBlend(b, e, 0.3, all[1] as SleeveRow);
    expect(resumed.map((r) => r.as_of_date)).toEqual([d(2), d(3)]);
    expect(resumed[1].blended_nav).toBeCloseTo(all[3].blended_nav, 9);
  });
  it("bridges a short ETF gap as-of but never invents a return across a long one", () => {
    const b = book([1000, 1010, 1020]);
    const bridged = extendBlend(b, new Map([[d(0), 100], [d(1), 101]]), 0.2, null);
    expect(bridged).toHaveLength(3); // d(2) uses the d(1) level (within 4 days): ETF return 0 for that step
    expect(bridged[2].etf_close).toBe(101);
    expect(extendBlend(book([1000, 1010]), new Map([["2020-01-01", 100]]), 0.2, null)).toEqual([]);
    const gap = new Map([[d(0), 100], [d(1), 101]]);
    const long = extendBlend(book([1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070]), gap, 0.2, null);
    expect(long.length).toBeLessThan(8); // stops once the last known level is more than 4 days old
  });
  it("computes drawdown, volatility and return per drawdown", () => {
    const m = pathMetrics([100, 110, 99, 105])!;
    expect(m.totalReturnPct).toBeCloseTo(5, 6);
    expect(m.maxDrawdownPct).toBeCloseTo(-10, 6);
    expect(m.returnPerDrawdown).toBeCloseTo(0.5, 6);
    expect(pathMetrics([100, 101])).toBeNull();
  });
  it("measures beta, capture and tracking error of the real book against the ETF", () => {
    const rows = [100, 102, 100, 103, 101, 104].map((e, i) => ({ as_of_date: d(i), etf_close: e, book_nav: 1000 * (1 + (e / 100 - 1) * 0.5) }));
    const m = bookVsEtf(rows)!;
    expect(m.beta!).toBeGreaterThan(0.45);
    expect(m.beta!).toBeLessThan(0.55);
    expect(m.correlation!).toBeGreaterThan(0.99);
    expect(m.upDays + m.downDays).toBe(5);
    expect(bookVsEtf(rows.slice(0, 2))).toBeNull();
  });
  it("gates any reading on enough sessions and both market phases", () => {
    expect(sleeveEvidenceState(30, -5, 12, 18).state).toBe("collecting");
    expect(sleeveEvidenceState(70, -7, 26, 40).state).toBe("measured");
    expect(sleeveEvidenceState(70, 1, 8, 62).state).toBe("one_regime");
  });
});
