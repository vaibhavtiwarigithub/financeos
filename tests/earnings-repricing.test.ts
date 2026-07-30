import { describe, expect, it } from "vitest";
import { evaluateEarningsRepricingBarrier } from "@/lib/risk/earnings-repricing";

const actual = {
  report_date: "2026-07-29",
  actual_available_at: "2026-07-30T02:10:00.000Z",
  announcement_session: "after_close",
  eps_actual_first: 4.74,
};

describe("earnings repricing barrier", () => {
  it("blocks a daily score based on the earnings-day close after an AMC result", () => {
    expect(evaluateEarningsRepricingBarrier({ latestDailyCandleDate: "2026-07-29", earnings: actual }))
      .toMatchObject({ pending: true, reason: "post_event_daily_bar_missing" });
  });

  it("releases only after a strictly post-event daily bar exists", () => {
    expect(evaluateEarningsRepricingBarrier({ latestDailyCandleDate: "2026-07-30", earnings: actual }))
      .toMatchObject({ pending: false, reason: "post_event_daily_bar_available" });
  });

  it("does not invent a barrier from absent or malformed calendar data", () => {
    expect(evaluateEarningsRepricingBarrier({ latestDailyCandleDate: "2026-07-29", earnings: null }).pending).toBe(false);
    expect(evaluateEarningsRepricingBarrier({ latestDailyCandleDate: "2026-07-29", earnings: { ...actual, report_date: "bad" } }).pending).toBe(false);
  });
});
