import { describe, expect, it } from "vitest";
import { replayHistoryNeedsRefresh } from "./replay-history-refresh";

describe("replayHistoryNeedsRefresh", () => {
  const dates = {
    expectedLatestDate: "2026-09-25",
    oldestAcceptableDate: "2021-10-03",
  };

  it("refreshes a five-year-complete series when its latest session is stale", () => {
    expect(replayHistoryNeedsRefresh({ oldestDate: "2021-07-26", latestDate: "2026-07-24", ...dates })).toBe(true);
  });

  it("does not refresh when depth and latest session are current", () => {
    expect(replayHistoryNeedsRefresh({ oldestDate: "2021-07-26", latestDate: "2026-09-25", ...dates })).toBe(false);
  });

  it("refreshes when five-year history depth is insufficient", () => {
    expect(replayHistoryNeedsRefresh({ oldestDate: "2022-01-01", latestDate: "2026-09-25", ...dates })).toBe(true);
  });
});
