import { describe, expect, it } from "vitest";
import { buildPositionPlanHistory, type PositionPlanEventRow } from "@/lib/portfolio/position-history";
const row: PositionPlanEventRow = { id: "1", position_id: "position-1", market: "us", symbol: "TEST", position_role: "alpha", opened_at: "2026-06-01T15:00:00Z", recorded_at: "2026-10-27T15:00:00Z", event_kind: "baseline", previous_stop_loss: null, previous_target: null, stop_loss: 90, price_target: 120 };
const args = { positionId: row.position_id, market: "us" as const, symbol: "TEST", positionRole: "alpha", openedAt: row.opened_at, stopLoss: 95, target: null, observedAt: "2026-10-27T15:05:00Z" };
const changed: PositionPlanEventRow = { ...row, id: "2", recorded_at: "2026-10-27T15:02:00Z", event_kind: "level_change", previous_stop_loss: 90, previous_target: 120, stop_loss: 95, price_target: null };

describe("paper exit-plan history", () => {
  it("starts at the observed baseline, preserves target removal and extends to the current observation", () => {
    const result = buildPositionPlanHistory({ ...args, rows: [changed, row] });
    expect(result.planHistoryStatus).toBe("recorded");
    expect(result.planPoints?.map(p => [p.at,p.stopLoss,p.target,p.source])).toEqual([
      [row.recorded_at,90,120,"baseline"], [changed.recorded_at,95,null,"recorded_change"], [args.observedAt,95,null,"current_snapshot"],
    ]);
    expect(result.planPoints?.[1].previousTarget).toBe(120);
    expect(result.planPoints?.[0].at).not.toBe(row.opened_at);
  });
  it.each(["position_id","market","symbol","position_role","opened_at"] as const)("excludes other %s identities and earlier epochs", field => {
    const foreign = { ...row, [field]: "other" };
    const result = buildPositionPlanHistory({ ...args, rows: [foreign] });
    expect(result.planHistoryStatus).toBe("unavailable");
    expect(result.planPoints).toHaveLength(1);
    expect(result.planPoints?.[0].source).toBe("current_snapshot");
  });
  it("refuses a discontinuous chain rather than drawing across missing changes", () => {
    const result = buildPositionPlanHistory({ ...args, rows: [row,{ ...changed,previous_stop_loss: 94 }] });
    expect(result.planHistoryStatus).toBe("unavailable");
  });
  it("does not claim complete history on a failed or capped page", () => {
    expect(buildPositionPlanHistory({ ...args, rows: [row,changed], unavailable: true }).planHistoryStatus).toBe("unavailable");
    expect(buildPositionPlanHistory({ ...args, rows: [row,changed], truncated: true }).planHistoryStatus).toBe("truncated");
  });
  it("refuses mixed current state and malformed price/time instead of relabelling it fresh", () => {
    expect(buildPositionPlanHistory({ ...args, rows: [row] }).planHistoryStatus).toBe("unavailable");
    expect(buildPositionPlanHistory({ ...args, rows: [{ ...changed,stop_loss: "NaN" }] }).planHistoryStatus).toBe("unavailable");
    expect(buildPositionPlanHistory({ ...args, rows: [{ ...changed,recorded_at: "bad" }] }).planHistoryStatus).toBe("unavailable");
  });
  it("does not join an old hold across a reused identity or role round-trip", () => {
    const reset = { ...changed, event_kind: "epoch_reset", previous_stop_loss: 88 };
    const result = buildPositionPlanHistory({ ...args, rows: [row,reset] });
    expect(result.planHistoryStatus).toBe("recorded");
    expect(result.planPoints).toHaveLength(2);
    expect(result.planPoints?.[0].at).toBe(reset.recorded_at);
    expect(result.planPoints?.[0].source).toBe("position_created");
  });
  it("orders equal-millisecond events with exact bigint IDs and supports both markets and leveraged roles", () => {
    const first = { ...row,id: "9007199254740992",market: "india",position_role: "soxl_paper" };
    const last = { ...changed,id: "9007199254740993",recorded_at: row.recorded_at,market: "india",position_role: "soxl_paper" };
    const result = buildPositionPlanHistory({ ...args,market: "india",positionRole: "soxl_paper",rows: [last,first] });
    expect(result.planHistoryStatus).toBe("recorded");
    expect(result.planPoints?.[0].eventId).toBe(first.id);
    expect(result.planPoints?.[1].eventId).toBe(last.id);
  });
});
