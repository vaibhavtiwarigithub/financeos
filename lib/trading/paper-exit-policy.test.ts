import { describe, expect, it } from "vitest";
import { paperPositionOpenedAt, resolvePaperExitThreshold } from "./paper-exit-policy";

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
});
