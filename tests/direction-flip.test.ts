import { describe, it, expect } from "vitest";
import { decideDirectionFlip, parseArmedSession, armedFlag, MIN_FLIP_HOLD_DAYS } from "@/lib/trading/direction-flip";

const S1 = "2026-07-20T13:00:00Z";
const S2 = "2026-07-21T13:00:00Z"; // strictly newer

describe("decideDirectionFlip", () => {
  it("arms (does NOT sell) on the first qualifying flip", () => {
    expect(decideDirectionFlip({ flipped: true, ageDays: 5, minHoldDays: 2, armedSession: null, currentSession: S1 }))
      .toBe("arm");
  });

  it("ignores a flip on a too-young position", () => {
    expect(decideDirectionFlip({ flipped: true, ageDays: 1, minHoldDays: 2, armedSession: null, currentSession: S1 }))
      .toBe("too_young");
  });

  it("holds when there is no flip and nothing armed", () => {
    expect(decideDirectionFlip({ flipped: false, ageDays: 5, minHoldDays: 2, armedSession: null, currentSession: S1 }))
      .toBe("hold");
  });

  it("confirms only when a STRICTLY NEWER session still flips", () => {
    expect(decideDirectionFlip({ flipped: true, ageDays: 6, minHoldDays: 2, armedSession: S1, currentSession: S2 }))
      .toBe("confirm");
  });

  it("does NOT confirm on the same session that armed it (no new research yet)", () => {
    expect(decideDirectionFlip({ flipped: true, ageDays: 6, minHoldDays: 2, armedSession: S1, currentSession: S1 }))
      .toBe("hold");
  });

  it("disarms when the armed flip reverts", () => {
    expect(decideDirectionFlip({ flipped: false, ageDays: 6, minHoldDays: 2, armedSession: S1, currentSession: S2 }))
      .toBe("disarm");
  });

  it("age unknown does not block arming (fail-open on missing open time)", () => {
    expect(decideDirectionFlip({ flipped: true, ageDays: null, minHoldDays: 2, armedSession: null, currentSession: S1 }))
      .toBe("arm");
  });

  it("round-trips the armed flag session", () => {
    expect(parseArmedSession(armedFlag(S1))).toBe(S1);
    expect(parseArmedSession("score_reassess_exit")).toBeNull();
    expect(parseArmedSession(null)).toBeNull();
  });

  it("default floor is 2 market days", () => {
    expect(MIN_FLIP_HOLD_DAYS).toBe(2);
  });
});
