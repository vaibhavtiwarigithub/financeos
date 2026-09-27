import { describe, expect, it } from "vitest";
import { validateAttributionRow } from "@/lib/shadows/attribution";
import { runPairedPortfolioReplay, type PairedPortfolioReplayInput } from "@/lib/shadows/paired-portfolio-replay";

const sessions = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];

function fixture(overrides: Partial<PairedPortfolioReplayInput> = {}): PairedPortfolioReplayInput {
  const entry = { id: "buy-d1", decisionId: "d1", session: sessions[1], symbol: "AAA", kind: "entry" as const, price: 100, quantity: 1, costPct: 0.001 };
  return {
    programId: "exit-geometry", market: "us", comparisonType: "matched_replay",
    programVersion: "exit-geometry-v1", baselineVersion: "baseline-v1",
    asOfSession: sessions[4], windowStart: sessions[0], windowEnd: sessions[4],
    expectedSessions: sessions,
    policy: { market: "us", currency: "USD", initialCash: 1000, maxOpenNames: 8, allowFractionalShares: true },
    baselineEvents: [entry, { id: "sell-base", session: sessions[4], symbol: "AAA", kind: "exit", price: 107, quantity: 1, costPct: 0.001 }],
    variantEvents: [entry, { id: "sell-variant", session: sessions[4], symbol: "AAA", kind: "exit", price: 108, quantity: 1, costPct: 0.001 }],
    marks: sessions.map((session, i) => ({ session, benchClose: 100 + i, prices: { AAA: 100 + i * 1.75 } })),
    baselineDecisionIds: ["d1", "d2"], variantDecisionIds: ["d2", "d1"],
    pointInTimeInputs: { decisions: ["d1", "d2"], source: "fixture" },
    costModelVersion: "test-10bps-v1", independenceBlockSessions: 2,
    ...overrides,
  };
}

describe("paired portfolio replay contract", () => {
  it("writes both gross and net portfolio outcomes only for common complete sessions", () => {
    const result = runPairedPortfolioReplay(fixture());
    expect(result.row.state).toBe("measured");
    expect(result.row.independent_sessions).toBe(2);
    expect(result.row.variant_net_portfolio_return_pct).toBeLessThan(result.row.variant_portfolio_return_pct!);
    expect(validateAttributionRow(result.row).valid).toBe(true);
    expect(result.diagnostics.unpricedSessions).toEqual({ baseline: 0, variant: 0 });
  });

  it("uses the same resolved shares in gross and net arms for cash-allocation buys", () => {
    const base = fixture();
    const baselineEvents = [{ ...base.baselineEvents[0], quantity: undefined, cashAllocation: 200 }];
    const variantEvents = [{ ...base.variantEvents[0], quantity: undefined, cashAllocation: 200 }];
    const result = runPairedPortfolioReplay(fixture({ baselineEvents, variantEvents }));
    expect(result.diagnostics.baselineFills).toBe(1);
    expect(result.diagnostics.variantFills).toBe(1);
    expect(result.row.turnover_pct).toBeCloseTo(19.98002, 5);
    expect(result.row.state).toBe("measured");
  });

  it("refuses cash-allocation sizing when costs change which events fit the cash budget", () => {
    const allocationBuy = {
      id: "buy-d1", decisionId: "d1", session: sessions[1], symbol: "AAA",
      kind: "entry" as const, price: 100, cashAllocation: 200, costPct: 0.001,
    };
    const tailBuy = {
      id: "buy-d2", decisionId: "d2", session: sessions[1], symbol: "BBB",
      kind: "entry" as const, price: 100, cashAllocation: 0.1, costPct: 0,
    };
    expect(() => runPairedPortfolioReplay(fixture({
      policy: { market: "us", currency: "USD", initialCash: 200, maxOpenNames: 8, allowFractionalShares: true },
      baselineEvents: [allocationBuy, tailBuy], variantEvents: [allocationBuy, tailBuy],
      marks: sessions.map((session, i) => ({ session, benchClose: 100 + i, prices: { AAA: 100, BBB: 100 } })),
      baselineDecisionIds: ["d1", "d2"], variantDecisionIds: ["d2", "d1"],
    }))).toThrow("Gross and net arms accepted different event sets");
  });

  it("mutation-detects a different point-in-time candidate population", () => {
    expect(() => runPairedPortfolioReplay(fixture({ variantDecisionIds: ["d1", "d3"] })))
      .toThrow("exact same unique point-in-time decision population");
  });

  it("mutation-detects an entry with no lineage into the shared candidate population", () => {
    const badEntry = { ...fixture().variantEvents[0], id: "mutant-buy", decisionId: "not-in-cohort" };
    expect(() => runPairedPortfolioReplay(fixture({ variantEvents: [badEntry, fixture().variantEvents[1]] })))
      .toThrow("link to a decision in the identical matched candidate population");
  });

  it("refuses a benchmark or held-symbol mark gap instead of carrying cost", () => {
    const marks = fixture().marks.map((mark, index) => index === 2 ? { ...mark, benchClose: null } : mark);
    expect(() => runPairedPortfolioReplay(fixture({ marks }))).toThrow("cover every expected market session");

    const heldSymbolGap = fixture().marks.map((mark, index) => index === 2 ? { ...mark, prices: {} } : mark);
    expect(() => runPairedPortfolioReplay(fixture({ marks: heldSymbolGap }))).toThrow("lacks a same-session price mark");
  });

  it("refuses a one-block claim as insufficient rather than emitting a measured row", () => {
    expect(() => runPairedPortfolioReplay(fixture({ independenceBlockSessions: 4 })))
      .toThrow("need at least 2");
  });

  it("does not call two empty cash-only books a measured portfolio replay", () => {
    expect(() => runPairedPortfolioReplay(fixture({ baselineEvents: [], variantEvents: [] })))
      .toThrow("empty cash-only books cannot claim portfolio P&L attribution");
  });
});
