import { describe, expect, it } from "vitest";
import { MIN_MATCHED_SESSIONS, runInternationalAllocationReplay } from "./international-replay";

function series(symbol: "voo" | "vxus", sessions: number, dailyReturn: number) {
  const start = new Date("2020-01-02T00:00:00Z");
  let close = 100;
  return Array.from({ length: sessions }, (_, index) => {
    if (index > 0) close *= 1 + dailyReturn;
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return { date: date.toISOString().slice(0, 10), close };
  });
}

describe("runInternationalAllocationReplay", () => {
  it("refuses to produce performance metrics with less than three years of matched history", () => {
    const result = runInternationalAllocationReplay(series("voo", MIN_MATCHED_SESSIONS - 1, 0.001), series("vxus", MIN_MATCHED_SESSIONS - 1, 0.001));
    expect(result.status).toBe("insufficient_history");
    expect(result.baseline).toBeNull();
  });

  it("keeps the static 100% VOO baseline separate from the monthly VXUS sleeve", () => {
    const result = runInternationalAllocationReplay(series("voo", MIN_MATCHED_SESSIONS + 10, 0.001), series("vxus", MIN_MATCHED_SESSIONS + 10, 0.002));
    expect(result.status).toBe("completed");
    expect(result.baseline?.totalReturnPct).toBeGreaterThan(0);
    expect(result.testSleeve?.totalReturnPct).toBeGreaterThan(result.baseline?.totalReturnPct ?? 0);
    expect(result.rebalanceCount).toBeGreaterThan(0);
    expect(result.windows).toHaveLength(3);
  });
});
