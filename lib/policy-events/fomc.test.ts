import { describe, expect, it } from "vitest";
import {
  completePostEventWindow,
  compoundReturn,
  resolveScheduledDecision,
  scheduledDecisionTimeReached,
  targetRanges,
  type FrozenReturn,
} from "@/lib/policy-events/fomc";

const row = (sessionDate: string, simpleReturn: number, priceBasis: "adjusted_close" | "raw_close" = "raw_close"): FrozenReturn => ({
  sessionDate, simpleReturn, priceBasis, source: "test",
});

describe("FOMC policy-event evidence", () => {
  it("joins the official target range by date and resolves only on/after the scheduled meeting", () => {
    const ranges = targetRanges(
      [{ date: "2026-07-28", value: 3.5 }, { date: "2026-07-30", value: 3.75 }],
      [{ date: "2026-07-28", value: 3.75 }, { date: "2026-07-30", value: 4 }],
    );

    expect(resolveScheduledDecision(ranges, "2026-07-29")).toEqual({ effectiveDate: "2026-07-30", lower: 3.75, upper: 4 });
    expect(resolveScheduledDecision(ranges, "2026-08-01")).toBeNull();
  });

  it("uses full sessions after the event, never the partial announcement session", () => {
    const window = completePostEventWindow([
      row("2026-07-29", 0.01), row("2026-07-30", 0.02), row("2026-07-31", -0.01),
    ], "2026-07-29", 2);

    expect(window?.map((value) => value.sessionDate)).toEqual(["2026-07-30", "2026-07-31"]);
    expect(compoundReturn(window ?? [])).toBeCloseTo(0.0098, 8);
  });

  it("refuses incomplete post-event horizons", () => {
    expect(completePostEventWindow([row("2026-07-30", 0.01)], "2026-07-29", 5)).toBeNull();
    expect(compoundReturn([])).toBeNull();
  });

  it("does not treat the pre-announcement target range as a same-day decision", () => {
    expect(scheduledDecisionTimeReached("2026-07-29", new Date("2026-07-29T17:59:00.000Z"))).toBe(false); // 13:59 ET
    expect(scheduledDecisionTimeReached("2026-07-29", new Date("2026-07-29T18:00:00.000Z"))).toBe(true); // 14:00 ET
  });
});
