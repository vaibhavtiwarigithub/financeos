import { describe, expect, it } from "vitest";
import { expectedMarketSessionsBetween } from "@/lib/trading/market-calendar";
import { validateAttributionRow } from "@/lib/shadows/attribution";
import { buildShadowBookSnapshot, type ShadowBookSnapshotRow, type ShadowBookState } from "@/lib/shadows/shadow-book-ledger";
import { buildShadowBookAttribution } from "@/lib/shadows/shadow-book-attribution";

const START = "2026-01-02";
const BLOCK = 10;

function state(session: string, qty: number): ShadowBookState {
  return { market: "us", session, cash: 0, positions: [{ symbol: "AAA", quantity: qty, costBasis: 100 }] };
}

function rowsFor(count: number): ShadowBookSnapshotRow[] {
  const sessions = [START, ...expectedMarketSessionsBetween("us", START, "2026-03-02")].slice(0, count);
  const initial = state(START, 1);
  const decisionIds = ["seed-position:AAA"];
  return sessions.map((session, index) => {
    const history = sessions.slice(0, index + 1).map((date, offset) => {
      const price = 100 + offset * 0.2;
      return {
        session: date,
        baselineState: state(date, 1),
        variantState: state(date, 1 + offset * 0.0005),
        prices: { AAA: price },
        benchmarkClose: 100 + offset * 0.1,
      };
    });
    const current = history.at(-1)!;
    return buildShadowBookSnapshot({
      programId: "exit-stop-shadow", market: "us", programVersion: "atr-v1", baselineVersion: "mandate-stop-v1",
      sessionDate: session, windowStart: START, expectedSessions: sessions.slice(0, index + 1), seedOnly: index === 0,
      independenceBlockSessions: BLOCK, baselineInitialState: initial, variantInitialState: initial,
      baselineState: current.baselineState, variantState: current.variantState, navHistory: history,
      turnoverNotional: index * 10, costsApplied: true, costModelVersion: "recorded-costs-v1",
      baselineDecisionIds: decisionIds, variantDecisionIds: decisionIds,
      pointInTimeInputs: { evidenceType: "forward_paired_book", sessionMark: { prices: current.prices, benchmarkClose: current.benchmarkClose }, decisionIds },
    });
  });
}

describe("paired shadow-book attribution", () => {
  it("waits for two complete non-overlapping blocks", () => {
    const rows = rowsFor(20); // seed plus 19 return intervals
    const result = buildShadowBookAttribution(rows, BLOCK);
    expect(result.state).toBe("collecting");
    if (result.state === "collecting") expect(result.independentBlocks).toBe(1);
  });

  it("writes an explicitly net-only measured row after two complete blocks", () => {
    const rows = rowsFor(21);
    const result = buildShadowBookAttribution(rows, BLOCK);
    expect(result.state).toBe("measured");
    if (result.state !== "measured") return;
    expect(result.row.return_basis).toBe("net_only");
    expect(result.row.baseline_portfolio_return_pct).toBeNull();
    expect(result.row.variant_portfolio_return_pct).toBeNull();
    expect(result.row.incremental_return_pct).toBeNull();
    expect(result.row.independent_sessions).toBe(2);
    expect(validateAttributionRow(result.row)).toEqual({ valid: true, reasons: [] });
  });

  it("refuses a missing snapshot session rather than shortening the window", () => {
    const rows = rowsFor(21);
    expect(() => buildShadowBookAttribution(rows.filter((_, index) => index !== 5), BLOCK))
      .toThrow("missing or extra market session");
  });

  it("refuses a corrupted population hash", () => {
    const rows = rowsFor(21);
    rows[10] = { ...rows[10], matched_population_hash: "wrong" };
    expect(() => buildShadowBookAttribution(rows, BLOCK)).toThrow("decision-population hash does not verify");
  });
});
