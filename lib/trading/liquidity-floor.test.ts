import { describe, expect, it } from "vitest";
import {
  ADV_MIN_SESSIONS, INDIA_MIN_AVG_TURNOVER_INR, assessLiquidityFloor, assessParticipation, averageTurnover, isQuietNameStaleQuote, type BarRow,
} from "@/lib/trading/liquidity-floor";

const bars = (n: number, close: number, volume: number): BarRow[] => Array.from({ length: n }, (_, i) => ({ date: `2026-09-${String(30 - i).padStart(2, "0")}`, close, volume }));

describe("india liquidity floor", () => {
  it("averages close x volume over the latest 20 sessions only", () => {
    const old = bars(5, 100, 1_000_000).map((b, i) => ({ ...b, date: `2026-08-${String(10 + i).padStart(2, "0")}` })); // huge but old
    const recent = bars(20, 100, 1000);
    const adv = averageTurnover([...old, ...recent]);
    expect(adv.sessions).toBe(20);
    expect(adv.avgTurnoverInr).toBe(100_000);
  });
  it("reports unknown (null) with too few sessions and ignores unusable bars", () => {
    expect(averageTurnover(bars(ADV_MIN_SESSIONS - 1, 100, 1000)).avgTurnoverInr).toBeNull();
    const bad: BarRow[] = [...bars(ADV_MIN_SESSIONS, 100, 1000), { date: "2026-10-01", close: null, volume: 5 }, { date: "2026-10-02", close: 100, volume: null }];
    expect(averageTurnover(bad).sessions).toBe(ADV_MIN_SESSIONS);
  });
  it("blocks below the INR 1 crore floor, passes at it, and fails closed when unknown", () => {
    expect(assessLiquidityFloor({ avgTurnoverInr: INDIA_MIN_AVG_TURNOVER_INR - 1, sessions: 20 })).toMatchObject({ ok: false, reason: "liquidity_floor" });
    expect(assessLiquidityFloor({ avgTurnoverInr: INDIA_MIN_AVG_TURNOVER_INR, sessions: 20 })).toEqual({ ok: true });
    expect(assessLiquidityFloor(undefined)).toMatchObject({ ok: false, reason: "liquidity_unknown" });
    expect(assessLiquidityFloor({ avgTurnoverInr: null, sessions: 3 })).toMatchObject({ ok: false, reason: "liquidity_unknown" });
  });
  it("caps an order at 5% of average daily turnover", () => {
    const adv = { avgTurnoverInr: 20_000_000, sessions: 20 }; // INR 2 crore
    expect(assessParticipation(adv, 1_000_000)).toEqual({ ok: true }); // exactly 5%
    expect(assessParticipation(adv, 1_000_001)).toMatchObject({ ok: false, reason: "adv_participation" });
    expect(assessParticipation(undefined, 1)).toMatchObject({ ok: false, reason: "liquidity_unknown" });
  });
  it("treats stale quotes on quiet names (< INR 5 crore) as expected, not an outage", () => {
    expect(isQuietNameStaleQuote({ avgTurnoverInr: 20_000_000, sessions: 20 })).toBe(true);
    expect(isQuietNameStaleQuote({ avgTurnoverInr: 800_000_000, sessions: 20 })).toBe(false);
    expect(isQuietNameStaleQuote(undefined)).toBe(false);
  });
});
