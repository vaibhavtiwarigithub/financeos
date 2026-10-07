import { describe, expect, it } from "vitest";
import { buildPositionHistorySeries, type PositionMarkRow } from "@/lib/portfolio/position-history";

const positionId = "7e61e6ee-0aca-4a44-a088-df0d1dc1eb83";
const base: PositionMarkRow = {
  position_id: positionId, symbol: "NVDA", market: "us", session_date: "2026-10-01",
  recorded_at: "2026-10-01T21:00:00.000Z", mark_price: "100", provenance: "live_quote",
  stale: false, source: "provider",
};

describe("position history series", () => {
  it("uses current-position, same-market marks after open and anchors to the first mark", () => {
    const result = buildPositionHistorySeries({
      positionId, symbol: "NVDA", market: "us", openedAt: "2026-10-01T15:00:00.000Z",
      rows: [
        { ...base, session_date: "2026-09-30", mark_price: 90 },
        base,
        { ...base, session_date: "2026-10-02", recorded_at: "2026-10-02T21:00:00Z", mark_price: 105 },
        { ...base, market: "india", session_date: "2026-10-03", mark_price: 200 },
        { ...base, position_id: "8e61e6ee-0aca-4a44-a088-df0d1dc1eb83", session_date: "2026-10-03", mark_price: 200 },
      ],
    });
    expect(result.status).toBe("ready");
    expect(result.points.map(p => p.sessionDate)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(result.points[0].returnPctFromFirstMark).toBe(0);
    expect(result.points[1].returnPctFromFirstMark).toBeCloseTo(5, 8);
  });

  it("keeps only the latest mark for a session and preserves its provenance", () => {
    const result = buildPositionHistorySeries({
      positionId, symbol: "NVDA", market: "us", openedAt: null,
      rows: [
        base,
        { ...base, recorded_at: "2026-10-01T22:00:00.000Z", mark_price: 102, provenance: "carry_forward", stale: true },
        { ...base, session_date: "2026-10-02", recorded_at: "2026-10-02T21:00:00Z", mark_price: 104 },
      ],
    });
    expect(result.points[0].markPrice).toBe(102);
    expect(result.points[0].stale).toBe(true);
    expect(result.points[1].returnPctFromFirstMark).toBeCloseTo(1.9608, 3);
  });

  it("does not fabricate values for missing, invalid, or one-mark histories", () => {
    const one = buildPositionHistorySeries({
      positionId, symbol: "NVDA", market: "us", openedAt: null,
      rows: [{ ...base, mark_price: 0 }, { ...base, mark_price: Number.NaN }, base],
    });
    expect(one.status).toBe("insufficient_history");
    expect(one.points).toHaveLength(1);
    const empty = buildPositionHistorySeries({ positionId, symbol: "NVDA", market: "us", openedAt: null, rows: [] });
    expect(empty.status).toBe("unavailable");
    expect(empty.points).toEqual([]);
  });
});
