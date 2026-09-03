import { describe, expect, it } from "vitest";
import {
  classifyCrossCheck,
  exchangeSessionDate,
  disputeAgeDays,
  DISPUTE_ESCALATION_RUNS,
} from "@/lib/paper/quote-crosscheck";
import { MARK_DISPUTE_REFUSE_PCT, MARK_CROSSCHECK_TOLERANCE_PCT } from "@/lib/paper/marks";
import fs from "node:fs";
import path from "node:path";

// features/quote-dispute-session-alignment
//
// A "disputed" verdict removes the symbol from priceMap BEFORE the exit loop,
// so it suppresses stop, target and time-stop evaluation entirely. These tests
// pin when that is allowed to happen.

const check = (over: Partial<Parameters<typeof classifyCrossCheck>[0]>) =>
  classifyCrossCheck({
    live: 100, cross: 100,
    liveSession: "2026-09-01", crossSession: "2026-09-01",
    refusePct: MARK_DISPUTE_REFUSE_PCT,
    tolerancePct: MARK_CROSSCHECK_TOLERANCE_PCT,
    ...over,
  });

describe("the production case that caused this change", () => {
  it("does NOT dispute INDUSTOWER.NS, whose 'disagreeing vendor' was the prior session", () => {
    // Refused every run 2026-08-26 -> 2026-09-01 on
    // "yahoo_india 375 vs upstox 388.8 (3.549%)". Yahoo's own closes:
    // 2026-09-01 = 375, 2026-08-31 = 388.79998779296875. The vendors never
    // disagreed about a price — the cross was one session behind. Two open
    // positions went seven days with no exit evaluation.
    const result = check({
      live: 375, cross: 388.79998779296875,
      liveSession: "2026-09-01", crossSession: "2026-08-31",
    });
    expect(result.verdict).toBe("session_mismatch");
    expect(result.refuse).toBe(false);          // stays priced -> exits evaluated
    expect(result.deltaPct).toBeGreaterThan(MARK_DISPUTE_REFUSE_PCT); // and would have been refused before
  });

  it("STILL disputes KAMATHOTEL.NS, where the disagreement is same-session", () => {
    // The same alert carried a second symbol with the OPPOSITE cause: Upstox
    // 225.09 matched the 2026-09-01 close (225.05) and the PRIMARY was the
    // outlier. Session alignment must not rescue this one.
    const result = check({
      live: 233.89, cross: 225.09,
      liveSession: "2026-09-01", crossSession: "2026-09-01",
    });
    expect(result.verdict).toBe("disputed");
    expect(result.refuse).toBe(true);
    expect(result.deltaPct).toBeCloseTo(3.909, 2);
  });
});

describe("session gate runs before any price comparison", () => {
  it("the monitor uses the Upstox exchange quote, not a lagging daily candle", () => {
    const route = fs.readFileSync(path.join(process.cwd(), "app/api/agents/position-monitor/route.ts"), "utf8");
    expect(route).toContain("fetchUpstoxBulkQuotes");
    expect(route).toContain('crossSource[sym] = "upstox_live"');
    expect(route).not.toContain("fetchUpstoxCandles");
  });
  it("treats an unknown session on either side as a mismatch, not a pass", () => {
    // Failing OPEN here would restore the original bug for exactly the rows
    // whose provenance cannot be established.
    expect(check({ live: 375, cross: 388.8, liveSession: null }).verdict).toBe("session_mismatch");
    expect(check({ live: 375, cross: 388.8, crossSession: null }).verdict).toBe("session_mismatch");
  });

  it("never refuses on a session mismatch, however far apart the prices are", () => {
    const result = check({ live: 10, cross: 1000, liveSession: "2026-09-01", crossSession: "2026-08-20" });
    expect(result.refuse).toBe(false);
    expect(result.verdict).toBe("session_mismatch");
  });

  it("reports no_cross when there is no second source at all", () => {
    expect(check({ cross: null }).verdict).toBe("no_cross");
    expect(check({ cross: 0 }).verdict).toBe("no_cross");
    expect(check({ live: null }).verdict).toBe("no_cross");
  });
});

describe("same-session verdicts are unchanged from the previous behaviour", () => {
  it("agrees inside tolerance", () => {
    expect(check({ live: 100, cross: 100.05 }).verdict).toBe("agreed");
  });

  it("marks divergent between tolerance and the refuse threshold", () => {
    const result = check({ live: 101, cross: 100 });
    expect(result.verdict).toBe("divergent");
    expect(result.refuse).toBe(false); // recorded and used, as before
  });

  it("refuses beyond the threshold", () => {
    const result = check({ live: 104, cross: 100 });
    expect(result.verdict).toBe("disputed");
    expect(result.refuse).toBe(true);
  });

  it("uses the threshold as a strict >, so exactly-at-threshold is not refused", () => {
    const result = check({ live: 103, cross: 100 });
    expect(result.deltaPct).toBeCloseTo(MARK_DISPUTE_REFUSE_PCT, 10);
    expect(result.refuse).toBe(false);
  });
});

describe("exchangeSessionDate uses the EXCHANGE timezone", () => {
  it("keeps an India close on its own IST date", () => {
    // 15:30 IST 2026-09-01 == 10:00Z the same day.
    expect(exchangeSessionDate("2026-09-01T10:00:00Z", "india")).toBe("2026-09-01");
  });

  it("does not roll an India evening instant into the next day", () => {
    // 23:00 IST 2026-09-01 is 17:30Z 2026-09-01 — same date either way, but
    // 01:00 IST 2026-09-02 is 19:30Z 2026-09-01, and UTC would call that
    // 09-01 while the exchange calls it 09-02. THAT is the off-by-one-session
    // error this whole feature exists to remove.
    expect(exchangeSessionDate("2026-09-01T19:30:00Z", "india")).toBe("2026-09-02");
    expect(exchangeSessionDate("2026-09-01T19:30:00Z", "us")).toBe("2026-09-01");
  });

  it("keeps a US close on its own ET date", () => {
    // 16:00 ET 2026-09-01 == 20:00Z.
    expect(exchangeSessionDate("2026-09-01T20:00:00Z", "us")).toBe("2026-09-01");
  });

  it("returns null for missing or unparseable input rather than guessing", () => {
    expect(exchangeSessionDate(null, "us")).toBeNull();
    expect(exchangeSessionDate("not a date", "us")).toBeNull();
  });
});

describe("dispute persistence escalation", () => {
  const now = new Date("2026-09-02T11:15:00Z");

  it("counts whole days since the dispute was first seen", () => {
    expect(disputeAgeDays("2026-08-26T11:15:00Z", now)).toBe(7);
    expect(disputeAgeDays("2026-09-02T09:00:00Z", now)).toBe(0);
  });

  it("escalates the real production case, which ran 7 days unguarded", () => {
    expect(disputeAgeDays("2026-08-26T11:15:00Z", now)).toBeGreaterThanOrEqual(DISPUTE_ESCALATION_RUNS);
  });

  it("does not escalate a first-run dispute", () => {
    expect(disputeAgeDays("2026-09-02T11:00:00Z", now)).toBeLessThan(DISPUTE_ESCALATION_RUNS);
  });

  it("returns 0 rather than NaN when the first-seen time is missing", () => {
    expect(disputeAgeDays(null, now)).toBe(0);
    expect(disputeAgeDays("garbage", now)).toBe(0);
  });
});
