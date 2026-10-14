import { describe, expect, it } from "vitest";
import { classifyLiveExitCollection, liveExitProducerRunTimestamps, type LiveExitMarketDiagnostics } from "@/lib/trading/live-exit-shadow-health";

const base: LiveExitMarketDiagnostics = {
  market: "us",
  accountConfigured: true,
  marketOpen: true,
  blockedReason: null,
  shadowMode: true,
  fillRowsRead: 1,
  accountMatchedFillRows: 1,
  accountMatchedBuyFills: 1,
  accountMatchedSellFills: 0,
  reconstructedPositions: 1,
  positionsChecked: 1,
  quotesUnavailable: 0,
  shadowRowsWritten: 1,
  stateWriteFailures: 0,
  shadowWriteFailures: 0,
};

describe("live exit Upgrade Path collection health", () => {
  it("persists explicit chronological start and finish timestamps", () => {
    const startedAt = new Date("2026-10-14T03:00:01.843Z");
    const timestamps = liveExitProducerRunTimestamps(startedAt, new Date("2026-10-14T03:00:01.708Z"));
    expect(timestamps.started_at).toBe("2026-10-14T03:00:01.843Z");
    expect(Date.parse(timestamps.finished_at)).toBeGreaterThanOrEqual(Date.parse(timestamps.started_at));
  });

  it("distinguishes a successful no-position wait from missing collection", () => {
    const outcome = classifyLiveExitCollection({
      ...base,
      accountMatchedFillRows: 0,
      accountMatchedBuyFills: 0,
      reconstructedPositions: 0,
      positionsChecked: 0,
      shadowRowsWritten: 0,
    });
    expect(outcome).toEqual({ status: "collected", state: "waiting_for_managed_position", blockers: [] });
  });

  it("flags a filled buy that is not reconstructed as a real lineage blocker", () => {
    expect(classifyLiveExitCollection({
      ...base,
      reconstructedPositions: 0,
      positionsChecked: 0,
      shadowRowsWritten: 0,
    })).toMatchObject({ status: "blocked", state: "filled_buy_not_reconstructed" });
  });

  it("does not call an out-of-session invocation a missing data event", () => {
    expect(classifyLiveExitCollection({ ...base, marketOpen: false })).toMatchObject({
      status: "collected", state: "outside_market_session", blockers: [],
    });
  });

  it("blocks unavailable quotes and failed shadow persistence", () => {
    expect(classifyLiveExitCollection({ ...base, quotesUnavailable: 1 })).toMatchObject({
      status: "blocked", state: "position_quote_unavailable",
    });
    expect(classifyLiveExitCollection({ ...base, shadowRowsWritten: 0 })).toMatchObject({
      status: "blocked", state: "shadow_row_count_mismatch",
    });
  });

  it("reports successful position evaluation without exposing account or symbol identifiers", () => {
    const outcome = classifyLiveExitCollection(base);
    expect(outcome).toEqual({ status: "collected", state: "shadow_evaluated", blockers: [] });
    expect(JSON.stringify(outcome)).not.toMatch(/account|symbol|IBIT/i);
  });
});
