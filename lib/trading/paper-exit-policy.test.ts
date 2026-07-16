import { describe, expect, it } from "vitest";
import { isPaperScoreFresh, marketSessionsSince, paperPositionOpenedAt, resolvePaperExitThreshold } from "./paper-exit-policy";

describe("paper exit policy", () => {
  it("derives exit hysteresis from the market mandate threshold", () => {
    expect(resolvePaperExitThreshold(60, 15)).toBe(45);
    expect(resolvePaperExitThreshold(52, 15)).toBe(37);
  });

  it("never lowers the exit threshold below the safety floor", () => {
    expect(resolvePaperExitThreshold(40, 20)).toBe(35);
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
