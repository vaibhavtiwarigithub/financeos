import { describe, expect, it } from "vitest";
import { buildShadowBookSnapshot, type ShadowBookSnapshotInput } from "./shadow-book-ledger";

function input(): ShadowBookSnapshotInput {
  const initialState = { market: "us" as const, session: "2026-08-03", cash: 500, positions: [{ symbol: "ABC", quantity: 5, costBasis: 100 }] };
  const baselineState = { ...initialState, session: "2026-08-05", cash: 600, positions: [{ symbol: "ABC", quantity: 4, costBasis: 100 }] };
  const variantState = { ...initialState, session: "2026-08-05", cash: 400, positions: [{ symbol: "ABC", quantity: 5, costBasis: 100 }] };
  return {
    programId: "exit-stop-shadow", market: "us", programVersion: "atr-2.8-v1", baselineVersion: "fixed-stop-v1",
    sessionDate: "2026-08-05", windowStart: "2026-08-03", expectedSessions: ["2026-08-03", "2026-08-04", "2026-08-05"],
    independenceBlockSessions: 2,
    baselineInitialState: initialState,
    variantInitialState: initialState,
    baselineState, variantState,
    navHistory: [
      { session: "2026-08-03", baselineState: initialState, variantState: initialState, prices: { ABC: 100 }, benchmarkClose: 100 },
      { session: "2026-08-04", baselineState: { ...initialState, session: "2026-08-04" }, variantState: { ...initialState, session: "2026-08-04", cash: 570, positions: [{ symbol: "ABC", quantity: 4, costBasis: 100 }] }, prices: { ABC: 120 }, benchmarkClose: 102 },
      { session: "2026-08-05", baselineState, variantState, prices: { ABC: 120 }, benchmarkClose: 105 },
    ],
    turnoverNotional: 100, costModelVersion: "paper-spread-v1", costsApplied: true,
    baselineDecisionIds: ["decision-1", "decision-2"], variantDecisionIds: ["decision-2", "decision-1"],
    pointInTimeInputs: { source: "fixture", market: "us" },
  };
}

describe("shadow book daily ledger", () => {
  it("records same-capital market-local net P&L and reports early windows as collecting", () => {
    const row = buildShadowBookSnapshot(input());
    expect(row.initial_nav).toBe(1000);
    expect(row.baseline_nav).toBe(1080);
    expect(row.variant_nav).toBe(1000);
    expect(row.baseline_cumulative_return_pct).toBeCloseTo(8);
    expect(row.variant_cumulative_return_pct).toBeCloseTo(0);
    expect(row.net_incremental_return_pct).toBeCloseTo(-8);
    expect(row.benchmark_cumulative_return_pct).toBeCloseTo(5);
    expect(row.benchmark_relative_incremental_return_pct).toBeCloseTo(-8);
    expect(row.baseline_drawdown_pct).toBeCloseTo(20 / 1100 * 100);
    expect(row.variant_drawdown_pct).toBeCloseTo(50 / 1050 * 100);
    expect(row.independent_blocks).toBe(1);
    expect(row.status).toBe("captured");
    expect(row.blockers).toHaveLength(2);
  });

  it("does not call collection statistically measured before two complete non-overlapping blocks", () => {
    const value = input();
    value.sessionDate = "2026-08-07";
    value.expectedSessions = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"];
    value.baselineState = { ...value.baselineState, session: value.sessionDate };
    value.variantState = { ...value.variantState, session: value.sessionDate };
    const last = value.navHistory[value.navHistory.length - 1];
    value.navHistory = [
      ...value.navHistory,
      { ...last, session: "2026-08-06", baselineState: { ...last.baselineState, session: "2026-08-06" }, variantState: { ...last.variantState, session: "2026-08-06" } },
      { ...last, session: "2026-08-07", baselineState: value.baselineState, variantState: value.variantState },
    ];
    const row = buildShadowBookSnapshot(value);
    expect(row.independent_blocks).toBe(2);
    expect(row.status).toBe("captured");
    expect(row.blockers).toHaveLength(1);
  });

  it("rejects a mismatched or duplicated candidate population", () => {
    const value = input();
    value.variantDecisionIds = ["decision-1", "decision-3"];
    expect(() => buildShadowBookSnapshot(value)).toThrow(/exact same/);
    value.variantDecisionIds = ["decision-1", "decision-1"];
    expect(() => buildShadowBookSnapshot(value)).toThrow(/exact same/);
  });

  it("allows different policy positions only when both arms start at equal NAV", () => {
    const value = input();
    value.variantInitialState = { ...value.baselineInitialState, cash: 0, positions: [{ symbol: "ABC", quantity: 10, costBasis: 100 }] };
    value.navHistory[0].variantState = value.variantInitialState;
    expect(buildShadowBookSnapshot(value).initial_nav).toBe(1000);
    const unequal = input();
    unequal.variantInitialState = { ...unequal.baselineInitialState, cash: 400 };
    unequal.navHistory[0].variantState = unequal.variantInitialState;
    expect(() => buildShadowBookSnapshot(unequal)).toThrow(/identical initial portfolio value/);
  });

  it("rejects missing held-symbol close marks instead of carrying cost basis", () => {
    const value = input();
    value.navHistory[1].prices = {};
    expect(() => buildShadowBookSnapshot(value)).toThrow(/Missing same-session close/);
  });

  it("rejects mixed markets, invalid session ordering, and a false net-cost claim", () => {
    const mixed = input();
    mixed.variantState = { ...mixed.variantState, market: "india" };
    expect(() => buildShadowBookSnapshot(mixed)).toThrow(/one market/);

    const unordered = input();
    unordered.expectedSessions = ["2026-08-03", "2026-08-05", "2026-08-04"];
    expect(() => buildShadowBookSnapshot(unordered)).toThrow(/ordered market-session/);

    const grossOnly = input();
    grossOnly.costsApplied = false as true;
    expect(() => buildShadowBookSnapshot(grossOnly)).toThrow(/Gross-only/);
  });

  it("rejects omitted session marks rather than silently shortening the NAV path", () => {
    const value = input();
    value.navHistory.pop();
    expect(() => buildShadowBookSnapshot(value)).toThrow(/Every expected market session/);
  });
});
