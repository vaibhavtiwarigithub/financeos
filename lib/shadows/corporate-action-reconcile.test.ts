import { describe, expect, it } from "vitest";
import { reconcileCorporateActionsForSession } from "./corporate-action-reconcile";

const now = new Date("2026-09-28T22:00:00.000Z");
const coverage = (symbol: string, action_type: string, records_count = 0) => ({
  symbol, action_type, status: "complete", checked_at: "2026-09-28T21:00:00.000Z",
  provider_fetched_at: "2026-09-28T21:00:00.000Z", records_count,
});

describe("reconcileCorporateActionsForSession", () => {
  it("accepts an explicitly covered no-action session", () => {
    const result = reconcileCorporateActionsForSession({
      symbols: ["ABC"], session: "2026-09-28", yahooActions: [], ledgerRows: [],
      coverageRows: [coverage("ABC", "split"), coverage("ABC", "dividend")], now,
    });
    expect(result).toEqual({ actions: [], blockers: [] });
  });

  it("does not mistake an empty coverage ledger for no corporate action", () => {
    const result = reconcileCorporateActionsForSession({
      symbols: ["ABC"], session: "2026-09-28", yahooActions: [], ledgerRows: [], coverageRows: [], now,
    });
    expect(result.actions).toBeNull();
    expect(result.blockers).toHaveLength(2);
  });

  it("accepts only matching fresh split/dividend terms", () => {
    const result = reconcileCorporateActionsForSession({
      symbols: ["ABC"], session: "2026-09-28",
      yahooActions: [
        { symbol: "ABC", session: "2026-09-28", type: "split", splitRatio: 2 },
        { symbol: "ABC", session: "2026-09-28", type: "dividend", dividendPerShare: 0.25 },
      ],
      ledgerRows: [
        { symbol: "ABC", action_type: "split", ex_date: "2026-09-28", split_ratio: 2 },
        { symbol: "ABC", action_type: "dividend", ex_date: "2026-09-28", dividend_amount: 0.25 },
      ],
      coverageRows: [coverage("ABC", "split", 1), coverage("ABC", "dividend", 1)], now,
    });
    expect(result).toMatchObject({ blockers: [], actions: [
      { symbol: "ABC", session: "2026-09-28", type: "split", splitRatio: 2 },
      { symbol: "ABC", session: "2026-09-28", type: "dividend", dividendPerShare: 0.25 },
    ] });
  });

  it("refuses missing, extra, mismatched, or stale source events", () => {
    const mismatched = reconcileCorporateActionsForSession({
      symbols: ["ABC"], session: "2026-09-28",
      yahooActions: [{ symbol: "ABC", session: "2026-09-28", type: "split", splitRatio: 2 }],
      ledgerRows: [], coverageRows: [coverage("ABC", "split", 1), coverage("ABC", "dividend")], now,
    });
    expect(mismatched.actions).toBeNull();
    expect(mismatched.blockers).toContain("ABC:split disagrees between raw-bar provider and persisted action ledger for 2026-09-28.");

    const stale = reconcileCorporateActionsForSession({
      symbols: ["ABC"], session: "2026-09-28", yahooActions: [], ledgerRows: [],
      coverageRows: [
        { ...coverage("ABC", "split"), checked_at: "2026-08-01T00:00:00.000Z", provider_fetched_at: "2026-08-01T00:00:00.000Z" },
        coverage("ABC", "dividend"),
      ], now,
    });
    expect(stale.actions).toBeNull();
    expect(stale.blockers[0]).toContain("lacks fresh complete source coverage");
  });
});
