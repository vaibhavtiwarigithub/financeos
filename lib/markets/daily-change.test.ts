import { describe, it, expect } from "vitest";
import {
  buildQuote,
  computeDailyChange,
  etCalendarDate,
  isWeekend,
  previousCalendarDate,
  priorSessionCandidates,
} from "./daily-change";

// Fixtures are REAL Massive values, pulled live on 2026-07-16 and cross-checked
// against /v2/aggs/grouped for the 07-15 and 07-14 sessions.
//
//   XLK  07-16 session: open 179.00 → close 177.52   (intraday −0.83%)
//        07-15 close: 181.58                          (true daily −2.24%)
//   SPY  07-16 session: open 752.76 → close 750.72   (intraday −0.27%)
//        07-15 close: 754.81                          (true daily −0.54%)
const XLK = { open: 179.0, close: 177.52, priorClose: 181.58 };
const SPY = { open: 752.76, close: 750.72, priorClose: 754.81 };

describe("computeDailyChange — close vs PRIOR close, never open→close", () => {
  it("reports XLK's true daily change of -2.24%, not the -0.83% intraday move", () => {
    const daily = computeDailyChange(XLK.close, XLK.priorClose)!;
    expect(daily.changePct).toBe(-2.24);
    expect(daily.change).toBe(-4.06);

    // Guard against a regression to the open→close formula, which understated
    // this move by 2.7x.
    const intradayPct = ((XLK.close - XLK.open) / XLK.open) * 100;
    expect(Number(intradayPct.toFixed(2))).toBe(-0.83);
    expect(daily.changePct).not.toBe(Number(intradayPct.toFixed(2)));
    expect(Math.abs(daily.changePct)).toBeGreaterThan(Math.abs(intradayPct) * 2);
  });

  it("reports SPY's true daily change of -0.54%, not the -0.27% intraday move", () => {
    const daily = computeDailyChange(SPY.close, SPY.priorClose)!;
    expect(daily.changePct).toBe(-0.54);
    const intradayPct = Number((((SPY.close - SPY.open) / SPY.open) * 100).toFixed(2));
    expect(intradayPct).toBe(-0.27);
    expect(daily.changePct).not.toBe(intradayPct);
  });

  it("keeps the correct SIGN when a session gaps down and rallies", () => {
    // Real XLRE 2026-07-15: open 44.61 → close 44.56 (intraday −0.11%, RED)
    // but prior close (07-14) was 44.48, so the day was actually +0.18% GREEN.
    const intradayPct = ((44.56 - 44.61) / 44.61) * 100;
    expect(intradayPct).toBeLessThan(0); // open→close says RED

    const daily = computeDailyChange(44.56, 44.48)!;
    expect(daily.changePct).toBeGreaterThan(0); // truth says GREEN
    expect(daily.changePct).toBe(0.18);
  });

  it("returns null (never 0) when the prior close is missing or unusable", () => {
    expect(computeDailyChange(177.52, null)).toBeNull();
    expect(computeDailyChange(177.52, undefined)).toBeNull();
    expect(computeDailyChange(177.52, 0)).toBeNull();
    expect(computeDailyChange(177.52, -1)).toBeNull();
    expect(computeDailyChange(NaN, 181.58)).toBeNull();
  });
});

describe("buildQuote — a fetch failure must never render as +0.00%", () => {
  it("marks a failed fetch unavailable with null values and a reason", () => {
    const q = buildQuote("XLK", "Technology", null, null, "provider timed out");
    expect(q.status).toBe("unavailable");
    expect(q.price).toBeNull();
    expect(q.change).toBeNull();
    expect(q.changePct).toBeNull();
    expect(q.reason).toBe("provider timed out");

    // The specific regression: zeros rendered as a confident green +0.00% pill,
    // indistinguishable from a genuinely flat sector.
    expect(q.changePct).not.toBe(0);
  });

  it("marks a quote unavailable when the close resolved but the prior close did not", () => {
    const bar = { symbol: "XLK", close: 177.52, sessionDate: "2026-07-16" };
    const q = buildQuote("XLK", "Technology", bar, null);
    expect(q.status).toBe("unavailable");
    expect(q.price).toBe(177.52); // the close IS known
    expect(q.changePct).toBeNull(); // the change is NOT
    expect(q.reason).toMatch(/prior close/i);
  });

  it("builds an ok quote from a real close + prior close", () => {
    const bar = { symbol: "XLK", close: XLK.close, sessionDate: "2026-07-16" };
    const q = buildQuote("XLK", "Technology", bar, XLK.priorClose);
    expect(q.status).toBe("ok");
    expect(q.price).toBe(177.52);
    expect(q.changePct).toBe(-2.24);
    expect(q.reason).toBeUndefined();
  });

  it("distinguishes a genuinely flat sector from an unavailable one", () => {
    const flat = buildQuote("XLV", "Healthcare", { symbol: "XLV", close: 100, sessionDate: "2026-07-16" }, 100);
    const dead = buildQuote("XLV", "Healthcare", null, null, "provider timed out");
    expect(flat.status).toBe("ok");
    expect(flat.changePct).toBe(0);
    expect(dead.status).toBe("unavailable");
    expect(dead.changePct).toBeNull();
  });
});

describe("session date derivation", () => {
  it("maps a 16:00-ET close-stamped bar to its own calendar date", () => {
    // Massive's /prev and grouped stamp a session at 16:00 ET (= 20:00 UTC).
    expect(etCalendarDate(1784232000000)).toBe("2026-07-16");
    expect(etCalendarDate(1784145600000)).toBe("2026-07-15");
  });

  it("maps a 00:00-ET start-stamped bar to the same date (range endpoint)", () => {
    // The range endpoint stamps the SAME 07-15 session at 00:00 ET (04:00 UTC).
    expect(etCalendarDate(1784088000000)).toBe("2026-07-15");
  });

  it("steps back a calendar day across a month boundary", () => {
    expect(previousCalendarDate("2026-07-16")).toBe("2026-07-15");
    expect(previousCalendarDate("2026-07-01")).toBe("2026-06-30");
    expect(previousCalendarDate("2026-01-01")).toBe("2025-12-31");
  });

  it("identifies weekends", () => {
    expect(isWeekend("2026-07-18")).toBe(true); // Saturday
    expect(isWeekend("2026-07-19")).toBe(true); // Sunday
    expect(isWeekend("2026-07-16")).toBe(false); // Thursday
  });

  it("skips the weekend when proposing prior sessions for a Monday", () => {
    // 2026-07-20 is a Monday; the prior session is Friday 07-17.
    const candidates = priorSessionCandidates("2026-07-20");
    expect(candidates[0]).toBe("2026-07-17");
    expect(candidates.every((d) => !isWeekend(d))).toBe(true);
  });

  it("proposes successively older weekdays so holidays can be walked past", () => {
    const candidates = priorSessionCandidates("2026-07-16");
    expect(candidates.slice(0, 3)).toEqual(["2026-07-15", "2026-07-14", "2026-07-13"]);
  });
});
