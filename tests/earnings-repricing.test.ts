import { describe, expect, it } from "vitest";
import { evaluateEarningsRepricingBarrier, resolveEarningsRepricingBarrier } from "@/lib/risk/earnings-repricing";

const actual = {
  report_date: "2026-07-29",
  actual_available_at: "2026-07-30T02:10:00.000Z",
  announcement_session: "after_close",
  eps_actual_first: 4.74,
};

describe("earnings repricing barrier", () => {
  it("blocks a daily score based on the earnings-day close after an AMC result", () => {
    expect(evaluateEarningsRepricingBarrier({
      latestDailyCandleDate: "2026-07-29",
      earnings: actual,
      market: "us",
      now: new Date("2026-07-30T14:00:00.000Z"),
    }))
      .toMatchObject({ pending: true, reason: "post_event_daily_bar_missing" });
  });

  it("releases only after a strictly post-event daily bar exists", () => {
    expect(evaluateEarningsRepricingBarrier({
      latestDailyCandleDate: "2026-07-30",
      earnings: actual,
      market: "us",
      now: new Date("2026-07-30T21:00:00.000Z"),
    }))
      .toMatchObject({ pending: false, reason: "post_event_daily_bar_available" });
  });

  it("does not invent a barrier from absent or malformed calendar data", () => {
    expect(evaluateEarningsRepricingBarrier({ latestDailyCandleDate: "2026-07-29", earnings: null }).pending).toBe(false);
    expect(evaluateEarningsRepricingBarrier({ latestDailyCandleDate: "2026-07-29", earnings: { ...actual, report_date: "bad" } }).pending).toBe(false);
  });

  it("rejects impossible calendar dates instead of letting Date.parse normalize them", () => {
    expect(evaluateEarningsRepricingBarrier({
      latestDailyCandleDate: "2026-03-03",
      earnings: { ...actual, report_date: "2026-02-31" },
    })).toMatchObject({ pending: false, reason: "no_recent_event" });
  });

  it("uses the report-day close for a before-open event", () => {
    expect(evaluateEarningsRepricingBarrier({
      latestDailyCandleDate: "2026-07-29",
      earnings: { ...actual, announcement_session: "before_open" },
      market: "us",
      now: new Date("2026-07-29T21:00:00.000Z"),
    })).toMatchObject({ pending: false, reason: "post_event_daily_bar_available" });
  });

  it("blocks after a scheduled event even when the actual feed is late", () => {
    expect(evaluateEarningsRepricingBarrier({
      latestDailyCandleDate: "2026-07-29",
      earnings: { ...actual, actual_available_at: null },
      market: "us",
      now: new Date("2026-07-30T14:00:00.000Z"),
    })).toMatchObject({ pending: true, reason: "post_event_daily_bar_missing", actualAvailableAt: null });
  });

  it("does not block an after-close event before it has occurred", () => {
    expect(evaluateEarningsRepricingBarrier({
      latestDailyCandleDate: "2026-07-28",
      earnings: { ...actual, actual_available_at: null },
      market: "us",
      now: new Date("2026-07-29T15:00:00.000Z"),
    })).toMatchObject({ pending: false, reason: "event_not_occurred" });
  });

  it("abstains when the calendar control-plane read fails", async () => {
    const query: any = {
      select: () => query,
      eq: () => query,
      lte: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async () => ({ data: null, error: { message: "unavailable" } }),
    };
    const state = await resolveEarningsRepricingBarrier({ from: () => query }, {
      symbol: "AAPL",
      market: "us",
      latestDailyCandleDate: "2026-07-30",
    });
    expect(state).toMatchObject({ pending: true, reason: "calendar_unavailable" });
  });
});
