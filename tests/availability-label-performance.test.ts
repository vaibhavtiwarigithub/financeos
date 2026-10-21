import { describe, expect, it, vi } from "vitest";
const counter = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/trading/market-calendar", async (original) => {
  const actual = await original<typeof import("@/lib/trading/market-calendar")>();
  return { ...actual, getMarketDayStatus: (...args: Parameters<typeof actual.getMarketDayStatus>) => {
    counter.calls++; return actual.getMarketDayStatus(...args);
  } };
});
import { availabilityAlignedLabel } from "@/lib/llm-council/availability-label";

describe("availability label bounded calendar work", () => {
  it("does calendar work per unique daily date, not forecasts multiplied by history", () => {
    const marks = Array.from({ length: 240 }, (_, i) => ({ date: new Date(Date.UTC(2026, 2, 1 + i)).toISOString().slice(0, 10), close: 100 + i }));
    const input = { market: "us" as const, availableAt: "2026-09-28T19:00:00Z", asOf: "2026-10-21T21:00:00Z", horizonDays: 2, symbolMarks: marks, benchmarkMarks: marks };
    for (let i = 0; i < 100; i++) {
      const result = availabilityAlignedLabel(input);
      expect(result?.entrySession).toBe("2026-09-28");
      expect(result?.endSession).toBe("2026-09-30");
      expect(result?.benchmarkNeutralReturn).toBe(0);
    }
    expect(counter.calls).toBeLessThanOrEqual(marks.length + 5);
    // Availability/as-of are NEVER memoized: the same marks must still refuse
    // a forecast made after the expected close or before the endpoint matures.
    expect(availabilityAlignedLabel({ ...input, asOf: "2026-09-30T19:59:59Z" })).toBeNull();
    expect(availabilityAlignedLabel({ ...input, availableAt: "2026-09-28T21:00:00Z" })?.entrySession).toBe("2026-09-29");
  });
});
