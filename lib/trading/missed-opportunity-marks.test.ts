import { describe, expect, it } from "vitest";
import { buildMissedOpportunityMarks, type MissedCloseRow, type MissedEntrySnapshot } from "./missed-opportunity-marks";

const snapshot: MissedEntrySnapshot = {
  decision_at: "2026-09-01T15:00:00.000Z", market: "us", symbol: "BE",
  reference_price: 100, hypothetical_fill_price: 101,
  hypothetical_qty: 2, hypothetical_notional: 202,
  stop_loss: 95, price_target: 110, horizon_sessions: 3,
};
const candidate: MissedCloseRow[] = [
  { symbol: "BE", market: "us", session_date: "2026-09-01", available_at: "2026-09-01T21:00:00.000Z", price_basis: "raw_close", close: 103 }, // decision-session close excluded
  { symbol: "BE", market: "us", session_date: "2026-09-02", available_at: "2026-09-02T21:00:00.000Z", price_basis: "adjusted_close", close: 106 }, // basis rejected
  { symbol: "BE", market: "us", session_date: "2026-09-02", available_at: "2026-09-02T21:00:00.000Z", price_basis: "raw_close", close: 105 },
  { symbol: "BE", market: "us", session_date: "2026-09-02", available_at: "2026-09-02T22:00:00.000Z", price_basis: "raw_close", close: 106 }, // newest append-only revision wins; one session only
  { symbol: "BE", market: "us", session_date: "2026-09-03", available_at: "2026-09-03T21:00:00.000Z", price_basis: "raw_close", close: 111 },
  { symbol: "BE", market: "us", session_date: "2026-09-04", available_at: "2026-09-04T21:00:00.000Z", price_basis: "raw_close", close: 102 },
];
const benchmark: MissedCloseRow[] = [
  { symbol: "VOO", market: "us", session_date: "2026-08-31", available_at: "2026-08-31T20:00:00.000Z", close: 100 },
  { symbol: "VOO", market: "us", session_date: "2026-09-02", available_at: "2026-09-02T21:00:00.000Z", close: 101 },
  { symbol: "VOO", market: "us", session_date: "2026-09-04", available_at: "2026-09-04T21:00:00.000Z", close: 102 },
];

describe("missed-opportunity close marks", () => {
  it("uses only post-decision raw closes, anchored to the paper fill proxy", () => {
    const marks = buildMissedOpportunityMarks({ snapshot, symbolCloses: candidate, benchmarkCloses: benchmark, benchmarkSymbol: "VOO" });
    expect(marks.points.map(point => point.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
    expect(marks.points[1].missedReturnPct).toBeCloseTo((106 / 101 - 1) * 100);
    expect(marks.missedReturnPct).toBeCloseTo((102 / 101 - 1) * 100);
    expect(marks.matchedSessions).toBe(2);
    expect(marks.points[2].benchmarkReturnPct).toBeNull();
    expect(marks.points[3].benchmarkReturnPct).toBeCloseTo(2);
    expect(marks.riskManagedExitSession).toBe("2026-09-03");
    expect(marks.riskManagedExitReason).toBe("target_close");
    expect(marks.riskManagedReturnPct).toBeCloseTo((111 / 101 - 1) * 100);
  });

  it("reports a stop close proxy separately from the unmanaged horizon mark", () => {
    const rows = [...candidate.filter(row => row.session_date !== "2026-09-03"),
      { symbol: "BE", market: "us", session_date: "2026-09-03", available_at: "2026-09-03T21:00:00.000Z", price_basis: "raw_close", close: 90 }];
    const marks = buildMissedOpportunityMarks({ snapshot, symbolCloses: rows, benchmarkCloses: benchmark, benchmarkSymbol: "VOO" });
    expect(marks.closeStopSession).toBe("2026-09-03");
    expect(marks.riskManagedExitSession).toBe("2026-09-03");
    expect(marks.riskManagedExitReason).toBe("stop_close");
    expect(marks.riskManagedReturnPct).toBeCloseTo((90 / 101 - 1) * 100);
    expect(marks.missedReturnPct).toBeCloseTo((102 / 101 - 1) * 100); // unmanaged horizon stays distinct
  });

  it("censors a later real buy of the symbol, even when it came from another signal", () => {
    const marks = buildMissedOpportunityMarks({ snapshot, symbolCloses: candidate, benchmarkCloses: benchmark,
      benchmarkSymbol: "VOO", subsequentBuyAt: "2026-09-03T19:00:00.000Z" });
    expect(marks.status).toBe("censored_by_later_fill");
    expect(marks.matured).toBe(false);
    expect(marks.observedSessions).toBe(1);
    expect(marks.points.at(-1)?.date).toBe("2026-09-02");
  });
});
