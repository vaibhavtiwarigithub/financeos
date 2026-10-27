import { describe, expect, it } from "vitest";
import { compareAllocation, liveSnapshotAllocation, paperAllocationBook } from "@/lib/allocation/comparison";
import { defaultAllocation } from "@/lib/allocation/profiles";

const policy = defaultAllocation("us");
const snapshot = (extra: Record<string, unknown> = {}) => ({ account_id: "test-account", broker: "alpaca_live", equity: 1000, captured_at: "2026-10-26T16:00:00Z", position_count: 1, positions_json: [{ symbol: "VOO", qty: 2, current_price: 400 }], ...extra });

describe("goal/current allocation display integrity", () => {
  it("uses marked paper holdings plus cash rather than a lagging stored NAV", () => {
    const book = paperAllocationBook([{ symbol: "AAPL", qty: 2, current_price: 450 }], 100);
    expect(book.nav).toBe(1000);
    expect(compareAllocation(policy, book).rows.find(r => r.bucket === "individual")?.currentPct).toBe(90);
  });
  it.each([null, 0])("never falls back to entry cost for an unpriced paper holding: %s", price => {
    expect(compareAllocation(policy, paperAllocationBook([{ symbol: "AAPL", qty: 2, current_price: price }], 100)).error).toBeTruthy();
  });
  it("compares an entire book and counts cash plus leverage once", () => {
    const mix = compareAllocation(policy, { nav: 1000, cash: 30, positions: [{ symbol: "VOO", marketValue: 400 }, { symbol: "AAPL", marketValue: 400 }, { symbol: "XLK", marketValue: 100 }, { symbol: "GLD", marketValue: 50 }, { symbol: "SOXL", marketValue: 20 }] });
    expect(mix.error).toBeNull();
    expect(mix.rows.map(r => r.currentPct)).toEqual([40, 40, 10, 0, 5, 0, 0, 5]);
    expect(mix.extra).toEqual([]);
  });
  it("does not count gold miners or energy equities as bullion or oil", () => {
    const mix = compareAllocation(policy, { nav: 100, cash: 0, positions: [{ symbol: "GDX", marketValue: 20 }, { symbol: "XOM", marketValue: 30 }, { symbol: "USO", marketValue: 50 }] });
    expect(mix.rows.find(r => r.bucket === "gold")?.currentPct).toBe(0);
    expect(mix.rows.find(r => r.bucket === "oil")?.currentPct).toBe(50);
    expect(mix.rows.find(r => r.bucket === "sector_etf")?.currentPct).toBe(20);
  });
  it("keeps Indian percentages independent and classifies local bullion funds", () => {
    const mix = compareAllocation(defaultAllocation("india"), { nav: 100000, cash: 10000, positions: [{ symbol: "NIFTYBEES.NS", marketValue: 80000 }, { symbol: "GOLDBEES.NS", marketValue: 10000 }] });
    expect(mix.rows.find(r => r.bucket === "core_etf")?.currentPct).toBe(80);
    expect(mix.rows.find(r => r.bucket === "gold")?.currentPct).toBe(10);
  });
  it("shows unknown exposure explicitly rather than silently classifying an unknown ETF as stock", () => {
    const mix = compareAllocation(policy, { nav: 100, cash: 0, positions: [{ symbol: "NOT-A-KNOWN-FUND", assetClass: "etf", marketValue: 100 }] });
    expect(mix.extra).toEqual([{ label: "Other / unclassified holdings", pct: 100 }]);
  });
  it.each([NaN, -1])("withholds current shares for an unpriced/short position: %s", value => {
    const mix = compareAllocation(policy, { nav: 100, cash: 0, positions: [{ symbol: "AAPL", marketValue: value }] });
    expect(mix.error).toBeTruthy(); expect(mix.rows.every(r => r.currentPct === null)).toBe(true);
  });
  it("does not normalize a mismatch or a zero-capital book into a plausible pie", () => {
    expect(compareAllocation(policy, { nav: 1000, cash: 100, positions: [{ symbol: "AAPL", marketValue: 500 }] }).error).toContain("reconcile");
    expect(compareAllocation(policy, { nav: 0, cash: 0, positions: [] }).error).toContain("positive");
  });
  it("keeps unknown cash separate from buying power", () => {
    const book = liveSnapshotAllocation([snapshot({ buying_power: 2000 })]);
    expect(book.cash).toBeNull();
    const mix = compareAllocation(policy, book);
    expect(mix.rows.find(r => r.bucket === "tactical")?.currentPct).toBe(0);
    expect(mix.extra).toEqual([{ label: "Unverified account balance", pct: 20 }]);
  });
  it("uses only latest same-account snapshot and excludes foreign/simulated books", () => {
    const book = liveSnapshotAllocation([snapshot({ captured_at: "2026-10-25T16:00:00Z", equity: 2000 }), snapshot(), snapshot({ broker: "kite", equity: 1000000 }), snapshot({ account_id: "sim", account_type: "simulated" })]);
    expect(book.nav).toBe(1000); expect(book.positions).toHaveLength(1);
    expect(book.note).toContain("2 out-of-scope");
  });
  it.each([
    { positions_json: [{ symbol: "VOO", qty: 2, average_buy_price: 400 }] },
    { positions_json: [{ symbol: "VOO", qty: -2, market_value: 800 }] },
    { position_count: 2 }, { captured_at: "2099-01-01T00:00:00Z" },
  ])("refuses incomplete broker marks/counts/shorts/future dates", fields => {
    expect(liveSnapshotAllocation([snapshot(fields)]).error).toBeTruthy();
  });
});
