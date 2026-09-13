import { describe, expect, it } from "vitest";
import {
  selectPendingTimeReviewWorklist,
  type TimeReviewMaturationOutcomeKey,
  type TimeReviewMaturationReview,
} from "@/lib/trading/time-review-shadow";
import { TIME_REVIEW_EXTENSIONS } from "@/lib/trading/time-review-exit";

function review(id: string): TimeReviewMaturationReview {
  return {
    id,
    policy_version: "time-review-v1",
    review_session: "2026-09-01",
    market: "us",
    symbol: "TEST",
    entry_price: 100,
    review_price: 101,
    effective_stop_price: 95,
    replacement_candidate_available: null,
  };
}

function complete(id: string): TimeReviewMaturationOutcomeKey[] {
  return TIME_REVIEW_EXTENSIONS.map((extension_days) => ({
    review_id: id,
    policy_version: "time-review-v1",
    extension_days,
  }));
}

describe("time-review outcome maturation worklist", () => {
  it("selects a later pending review even when the oldest 500 are complete", () => {
    const completed = Array.from({ length: 500 }, (_, index) => review(`done-${String(index).padStart(3, "0")}`));
    const laterPending = review("pending-later");
    const selected = selectPendingTimeReviewWorklist(
      [...completed, laterPending],
      completed.flatMap((row) => complete(row.id)),
      { limit: 500, rotationDay: 0 },
    );

    expect(selected.map((row) => row.id)).toEqual(["pending-later"]);
  });

  it("rotates a bounded pending worklist so an old incomplete prefix cannot starve later reviews", () => {
    const pending = Array.from({ length: 501 }, (_, index) => review(`pending-${String(index).padStart(3, "0")}`));
    const firstPage = selectPendingTimeReviewWorklist(pending, [], { limit: 500, rotationDay: 0 });
    const nextPage = selectPendingTimeReviewWorklist(pending, [], { limit: 500, rotationDay: 1 });

    expect(firstPage).toHaveLength(500);
    expect(firstPage.map((row) => row.id)).not.toContain("pending-500");
    expect(nextPage).toHaveLength(500);
    expect(nextPage.map((row) => row.id)).toContain("pending-500");
  });
});
