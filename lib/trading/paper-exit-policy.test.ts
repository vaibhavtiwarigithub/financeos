import { describe, expect, it } from "vitest";
import { isPaperScoreFresh, marketSessionsSince, paperPositionOpenedAt, resolvePaperExitThreshold } from "./paper-exit-policy";

describe("paper exit policy", () => {
  // THE DEFECT THESE NOW GUARD. This used to return max(35, entry - hysteresis):
  // at the live entry threshold of 60 with the profile's hysteresis of 15, a
  // held position had to collapse below 45 before the score could close it.
  // Measured over 203 closed paper lots the score exit fired ZERO times while
  // the time stop fired 140 — the calendar, not the research, was the real exit
  // policy. With the time stop removed (2026-09-10, superseding Decision 65) the
  // score exit is the primary non-price exit and must actually be reachable.
  it("exits at the ENTRY threshold — 'would this be bought today?'", () => {
    expect(resolvePaperExitThreshold(60, 15)).toBe(60);
    expect(resolvePaperExitThreshold(52, 15)).toBe(52);
  });

  it("ignores hysteresis — any dead band recreates the bug", () => {
    expect(resolvePaperExitThreshold(60, 0)).toBe(60);
    expect(resolvePaperExitThreshold(60, 40)).toBe(60);
    expect(resolvePaperExitThreshold(60)).toBe(60);
  });

  it("falls back to 60 only when the entry threshold is unusable", () => {
    expect(resolvePaperExitThreshold(Number.NaN, 15)).toBe(60);
  });

  it("uses the paper_positions opened_at column before legacy created_at", () => {
    expect(paperPositionOpenedAt({ opened_at: "2026-07-10", created_at: "2026-07-01" })).toBe("2026-07-10");
    expect(paperPositionOpenedAt({ created_at: "2026-07-01" })).toBe("2026-07-01");
  });

  it("counts market sessions and excludes the US July 3 holiday", () => {
    const now = new Date("2026-07-06T18:00:00Z");
    expect(marketSessionsSince("2026-07-02T18:00:00Z", now, "us")).toBe(1);
    expect(marketSessionsSince("2026-07-02T10:00:00Z", now, "india")).toBe(2);
  });

  it("fails stale, missing, and invalid score timestamps closed", () => {
    const now = new Date("2026-07-08T18:00:00Z");
    expect(isPaperScoreFresh("2026-07-06T18:00:00Z", now, "us", 2)).toBe(true);
    expect(isPaperScoreFresh("2026-07-02T18:00:00Z", now, "us", 2)).toBe(false);
    expect(isPaperScoreFresh(null, now, "us", 2)).toBe(false);
  });
});
