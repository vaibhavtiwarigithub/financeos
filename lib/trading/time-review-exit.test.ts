import { describe, expect, it } from "vitest";
import {
  classifyTimeReview,
  computeTimeReviewOutcome,
  TIME_REVIEW_EXTENSIONS,
  timeReviewIdempotencyKey,
  type TimeReviewInputs,
} from "@/lib/trading/time-review-exit";

const HEALTHY: TimeReviewInputs = {
  ageDays: 10,
  horizonDays: 10,
  entryPrice: 100,
  reviewPrice: 110,
  highWaterPrice: 112,
  initialStopPrice: 93,
  effectiveStopPrice: 103,
  targetPrice: 120,
  score: 72,
  scoreFresh: true,
  scoreDirection: "long",
  holdThreshold: 60,
};

describe("time-review exact-horizon classifier", () => {
  it("predeclares only the approved +5/+10 family", () => {
    expect(TIME_REVIEW_EXTENSIONS).toEqual([5, 10]);
  });

  it("qualifies a profitable, fresh, supported long inside one initial stop distance", () => {
    expect(classifyTimeReview(HEALTHY)).toMatchObject({ eligible: true, failed: [] });
  });

  it("cannot qualify before or after the exact review session", () => {
    for (const ageDays of [9, 11, 20]) {
      const result = classifyTimeReview({ ...HEALTHY, ageDays });
      expect(result.eligible).toBe(false);
      expect(result.failed).toContain("not_exact_horizon");
    }
  });

  it("fails closed on missing/stale score, non-long direction, loss, or missing stop geometry", () => {
    const cases: Array<[Partial<TimeReviewInputs>, string]> = [
      [{ score: null }, "score_missing"],
      [{ scoreFresh: false }, "score_stale"],
      [{ scoreDirection: "neutral" }, "direction_not_long"],
      [{ reviewPrice: 99 }, "not_profitable"],
      [{ initialStopPrice: null }, "stop_distance_missing"],
      [{ effectiveStopPrice: 111 }, "mechanical_stop_due"],
      [{ targetPrice: 109 }, "target_due"],
    ];
    for (const [change, reason] of cases) {
      const result = classifyTimeReview({ ...HEALTHY, ...change });
      expect(result.eligible).toBe(false);
      expect(result.failed).toContain(reason);
    }
  });

  it("rejects drawdown beyond the entry's initial stop distance", () => {
    const result = classifyTimeReview({ ...HEALTHY, highWaterPrice: 130, reviewPrice: 110 });
    expect(result.failed).toContain("drawdown_exceeds_stop_distance");
  });

  it("uses one deterministic observation key per position and review session", () => {
    const a = timeReviewIdempotencyKey({ market: "us", positionId: "p1", reviewSession: "2026-09-03" });
    const b = timeReviewIdempotencyKey({ market: "us", positionId: "p1", reviewSession: "2026-09-03" });
    const c = timeReviewIdempotencyKey({ market: "india", positionId: "p1", reviewSession: "2026-09-03" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("time-review matured outcome", () => {
  const forward = Array.from({ length: 10 }, (_, index) => ({
    date: `2026-09-${String(index + 4).padStart(2, "0")}`,
    close: 111 + index,
    high: 112 + index,
    low: 109 + index,
  }));

  it("compares the next-session incumbent with the predeclared extension", () => {
    const result = computeTimeReviewOutcome({
      entryPrice: 100, reviewPrice: 110, effectiveStopPrice: 103,
      forward, extensionDays: 5,
    });
    expect(result).not.toBeNull();
    expect(result?.baselineExitPrice).toBe(111);
    expect(result?.candidateExitPrice).toBe(115);
    expect(result?.incrementalVsBaselinePct).toBeCloseTo(4);
    expect(result?.mechanicalStopHit).toBe(false);
  });

  it("retains the frozen mechanical stop and truncates the path when hit", () => {
    const withStop = forward.map((bar, index) => index === 2 ? { ...bar, low: 102 } : bar);
    const result = computeTimeReviewOutcome({
      entryPrice: 100, reviewPrice: 110, effectiveStopPrice: 103,
      forward: withStop, extensionDays: 5,
    });
    expect(result?.mechanicalStopHit).toBe(true);
    expect(result?.mechanicalStopSession).toBe("2026-09-06");
    expect(result?.candidateExitPrice).toBe(103);
  });

  it("refuses an incomplete forward window", () => {
    expect(computeTimeReviewOutcome({
      entryPrice: 100, reviewPrice: 110, effectiveStopPrice: 93,
      forward: forward.slice(0, 4), extensionDays: 5,
    })).toBeNull();
  });
});
