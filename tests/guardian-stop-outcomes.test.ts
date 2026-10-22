import { describe, expect, it } from "vitest";
import { evaluateGuardianStop, guardianIssueDate, guardianOverlapExclusions, guardianResponse, guardianSessions, summarizeGuardianStops, type StopRecommendation } from "@/lib/live-recommendations/guardian-stop";
import type { GuardianOutcomeRow } from "@/types";
const rec = (changes: Partial<StopRecommendation> = {}): StopRecommendation => ({ id: 1, market: "us", account_id: "TEST", symbol: "TEST-NO-REAL-ASSET", issued_at: "2026-10-01T15:00:00Z", level_price: 95, qty_suggested: 10,
  source_table: "guardian_protection_plans", source_id: "1", guardian_contract: { version: "guardian_exact_stop_v1", reference_basis: "next_session_open", captured_at: "2026-10-01T15:00:00Z", episode_key: "plan:1", source_version: "test", extra_sell_cost_bps: 10 }, ...changes });
const dates = guardianSessions("us", rec().issued_at, 20)!;
const bar = (date: string, open = 100, high = 101, low = 99, close = 100) => ({ date, open, high, low, close });
const bars = () => dates.map(d => bar(d));
const asOf = new Date("2026-11-10T23:00:00Z");

describe("Guardian fixed next-session convention", () => {
  it("uses market-local capture date, not UTC and not original cost", () => {
    expect(guardianIssueDate("us", "2026-10-02T01:00:00Z")).toBe("2026-10-01");
    expect(guardianIssueDate("india", "2026-10-02T01:00:00Z")).toBe("2026-10-02");
    expect(guardianSessions("us", "2026-10-01T15:00:00Z", 2)).toEqual(["2026-10-02", "2026-10-05"]);
    expect(guardianSessions("india", "2026-10-01T15:00:00Z", 2)).toEqual(["2026-10-05", "2026-10-06"]);
    expect(guardianSessions("us", "2026-12-31T15:00:00Z", 2)).toBeNull();
  });
  it("ignores the unknowable issue-day low and all post-horizon prices", () => {
    const result = evaluateGuardianStop(rec(), [bar("2026-10-01", 100, 110, 1, 100), ...bars(), bar("2026-12-01", 10, 10, 1, 2)], 2, asOf);
    expect(result.state).toBe("ready"); expect(result.touchedOn).toBeNull(); expect(result.netDeltaPct).toBe(0);
    expect(result.priceWindow).toHaveLength(2);
  });
  it("waits for the actual horizon close, including early close rules", () => {
    expect(evaluateGuardianStop(rec(), bars(), 2, new Date("2026-10-05T19:59:59Z")).state).toBe("immature");
    expect(evaluateGuardianStop(rec(), bars(), 2, new Date("2026-10-05T20:00:00Z")).state).toBe("ready");
  });
});
describe("Guardian paired stop accounting", () => {
  it("models an ordinary stop and charges disclosed cost only on exit", () => {
    const path = bars(); path[0] = bar(dates[0], 100, 101, 94, 100); path[1] = bar(dates[1], 100, 101, 79, 80);
    const result = evaluateGuardianStop(rec(), path, 2, asOf);
    expect(result.stopFillPrice).toBe(95); expect(result.grossDeltaPct).toBeCloseTo(15);
    expect(result.netDeltaPct).toBeCloseTo(14.905); expect(result.monetaryDelta).toBeCloseTo(149.05);
  });
  it("does not fill a gap at the more favorable stop price", () => {
    const path = bars(); path[1] = bar(dates[1], 90, 91, 79, 80);
    const result = evaluateGuardianStop(rec(), path, 2, asOf);
    expect(result.stopFillPrice).toBe(90); expect(result.netDeltaPct).toBeCloseTo(9.91);
  });
  it("counts rebound upside sacrificed, not only saved losses", () => {
    const path = bars(); path[0] = bar(dates[0], 100, 101, 94, 100); path[1] = bar(dates[1], 100, 111, 99, 110);
    const result = evaluateGuardianStop(rec(), path, 2, asOf);
    expect(result.netDeltaPct).toBeCloseTo(-15.095);
  });
  it("unknown quantities do not produce zero or fictional currency profit", () => {
    const result = evaluateGuardianStop(rec({ qty_suggested: null }), bars(), 2, asOf);
    expect(result.monetaryDelta).toBeNull(); expect(result.notional).toBeNull();
  });
  it("does not fabricate absent, duplicate, malformed or corporate-action windows", () => {
    expect(evaluateGuardianStop(rec(), bars().slice(1), 2, asOf).state).toBe("missing_data");
    expect(evaluateGuardianStop(rec(), [...bars(), bar(dates[0])], 2, asOf).state).toBe("missing_data");
    const malformed = bars(); malformed[0].high = 0;
    expect(evaluateGuardianStop(rec(), malformed, 2, asOf).state).toBe("missing_data");
    expect(evaluateGuardianStop(rec(), bars(), 2, asOf, undefined, [dates[0]]).state).toBe("excluded_corporate_action");
    expect(evaluateGuardianStop(rec({ guardian_contract: null }), bars(), 2, asOf).state).toBe("legacy");
    const r = rec(); r.guardian_contract!.captured_at = "2026-09-01T00:00:00Z";
    expect(evaluateGuardianStop(r, bars(), 2, asOf).state).toBe("missing_data");
  });
  it("keeps each horizon and monetary coverage separate", () => {
    const path = bars(); path[1] = bar(dates[1], 90, 91, 79, 80);
    const o = evaluateGuardianStop(rec(), path, 2, asOf);
    const row: GuardianOutcomeRow = { id: 1, symbol: "TEST", issuedAt: rec().issued_at, source: "test", version: "test", stop: 95, qty: 10, response: { state: "unknown", reason: "test" }, outcomes: [o, { horizon: 5, state: "missing_data", reason: "absent" }] };
    const summary = summarizeGuardianStops([row]);
    expect(summary[0].evaluated).toBe(1); expect(summary[0].weightedDeltaPct).toBeCloseTo(o.netDeltaPct!);
    expect(summary[1].meanDeltaPct).toBeNull(); expect(summary[1].monetaryDelta).toBeNull();
  });
});
describe("episode and response integrity", () => {
  it("does not turn daily repetitions or plan/ledger duplication into new wins", () => {
    const second = rec({ id: 2, issued_at: "2026-10-02T15:00:00Z" }); second.guardian_contract = { ...second.guardian_contract!, captured_at: second.issued_at };
    const other = rec({ id: 3, account_id: "OTHER" });
    const exclusions = guardianOverlapExclusions([second, other, rec()]);
    expect(exclusions.has(2)).toBe(true); expect(exclusions.has(1)).toBe(false); expect(exclusions.has(3)).toBe(false);
  });
  const plan = { id: 1, ledger_entry_id: null, market: "us", account_id: "TEST", symbol: "TEST-NO-REAL-ASSET", status: "armed", trigger_proposal_id: 7 };
  const fill = { id: 1, proposal_id: 7, market: "us", broker_env: "live", broker_account_id: "TEST", symbol: "TEST-NO-REAL-ASSET", side: "sell", status: "filled", filled_qty: 10, avg_fill_price: 94, submitted_at: "2026-10-02T14:00:00Z", closed_at: "2026-10-02T14:00:01Z", broker_order_id: "TEST-ORDER", tainted: false };
  it("requires confirmed same-account matching fills; arming is not execution", () => {
    expect(guardianResponse(rec(), [plan], [], asOf).state).toBe("armed_only");
    expect(guardianResponse(rec(), [plan], [fill], asOf).state).toBe("confirmed_exit");
    expect(guardianResponse(rec(), [plan], [{ ...fill, filled_qty: 4 }], asOf).state).toBe("partial_exit");
    for (const mutation of [{ broker_account_id: "OTHER" }, { side: "buy" }, { market: "india" }, { broker_env: "paper" }, { status: "submitted" }, { tainted: true }, { filled_qty: 11 }, { closed_at: "2026-09-01T00:00:00Z" }, { broker_order_id: null }]) {
      expect(guardianResponse(rec(), [plan], [{ ...fill, ...mutation }], asOf).state).toBe("unknown");
    }
    expect(guardianResponse(rec(), [plan], [fill, fill], asOf).state).toBe("unknown");
    expect(guardianResponse(rec(), [], [fill], asOf).state).toBe("unknown");
  });
});
