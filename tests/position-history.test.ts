import { describe, expect, it } from "vitest";
import { buildPositionActivitySeries, buildPositionHistorySeries, type PositionActivityRow, type PositionMarkRow } from "@/lib/portfolio/position-history";

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

describe("position activity ladder", () => {
  const activityRow = (overrides: Partial<PositionActivityRow> = {}): PositionActivityRow => ({
    id: "trade-1", market: "us", symbol: "NVDA", order_side: "buy", qty: 4, fill_price: 100,
    executed_at: "2026-10-01T15:00:00.000Z", signal_id: "signal-1", paper_event_id: 101,
    position_role: "alpha", exit_price: null, exit_reason: null, exit_at: null, closed_at: null,
    partial_exit_lot: false, ...overrides,
  });

  it("rebuilds entry, add, and a partial sell while reconciling to the open quantity", () => {
    const result = buildPositionActivitySeries({
      positionId, symbol: "NVDA", market: "us", positionRole: "alpha",
      openedAt: "2026-10-01T14:59:00.000Z", currentQty: 7,
      rows: [
        activityRow({ id: "sold-slice", qty: 1, exit_price: 110, exit_reason: "partial_target", exit_at: "2026-10-02T16:00:00.000Z" }),
        activityRow({ id: "residual", qty: 3, partial_exit_lot: true }),
        activityRow({ id: "add", qty: 4, fill_price: 112, executed_at: "2026-10-03T15:00:00.000Z", paper_event_id: 102, signal_id: "signal-2" }),
      ],
    });
    expect(result.status).toBe("ready");
    expect(result.reconstructedQty).toBe(7);
    expect(result.events.map(event => [event.side, event.quantity, event.quantityAfter])).toEqual([
      ["buy", 4, 4], ["sell", 1, 3], ["buy", 4, 7],
    ]);
    expect(result.events[1].notional).toBe(110);
  });

  it("refuses to show a plausible chart when the reconstructed lots do not match the held quantity", () => {
    const result = buildPositionActivitySeries({
      positionId, symbol: "NVDA", market: "us", positionRole: "alpha",
      openedAt: "2026-10-01T14:59:00.000Z", currentQty: 5,
      rows: [activityRow({ qty: 4 })],
    });
    expect(result.status).toBe("reconciliation_mismatch");
    expect(result.reconstructedQty).toBe(4);
  });

  it("refuses ambiguous residual lineage and a missing open timestamp", () => {
    const ambiguous = buildPositionActivitySeries({
      positionId, symbol: "NVDA", market: "us", openedAt: "2026-10-01T14:59:00.000Z",
      currentQty: 3, rows: [activityRow({ signal_id: null, paper_event_id: null, partial_exit_lot: true })],
    });
    const noEpoch = buildPositionActivitySeries({
      positionId, symbol: "NVDA", market: "us", openedAt: null, currentQty: 4, rows: [activityRow()],
    });
    expect(ambiguous.status).toBe("unavailable");
    expect(noEpoch.status).toBe("unavailable");
  });
});
