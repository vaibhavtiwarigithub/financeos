import { beforeEach, describe, expect, it, vi } from "vitest";

const broker = vi.hoisted(() => ({
  cancelRobinhoodOrder: vi.fn(), queryRobinhoodOrder: vi.fn(),
}));
vi.mock("@/lib/robinhood-mcp", () => ({
  cancelRobinhoodOrder: broker.cancelRobinhoodOrder,
  queryRobinhoodOrder: broker.queryRobinhoodOrder,
  placeRobinhoodGtcStop: vi.fn(),
}));

import { cancelProtectiveStop } from "@/lib/protective/placement-worker";

function db(row: Record<string, unknown> | null) {
  const statuses: string[] = [];
  const reads = {
    select: () => reads, eq: () => reads, in: () => reads, limit: async () => ({ data: row ? [row] : [], error: null }),
  };
  const updates = {
    eq: async () => ({ error: null }),
  };
  const supabase = {
    from: (table: string) => table === "protective_orders" ? {
      ...reads,
      update: (value: { status: string }) => { statuses.push(value.status); return updates; },
    } : { insert: async () => ({ error: null }) },
  };
  return { supabase, statuses };
}

const active = { id: 7, broker_order_id: "stop-1", kite_trigger_id: null, status: "active", broker: "robinhood", market: "us" };
const input = { positionId: "us:robinhood:acct:SOXL", market: "us" as const, brokerAccountId: "acct" };

describe("protective stop cancellation confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    broker.cancelRobinhoodOrder.mockResolvedValue({ ok: true });
  });

  it("does not treat a cancel acknowledgement as final", async () => {
    broker.queryRobinhoodOrder.mockResolvedValue({ ok: true, status: "submitted", filledQty: 0 });
    const { supabase, statuses } = db(active);
    const result = await cancelProtectiveStop({ supabase, ...input });
    expect(result.ok).toBe(false);
    expect(statuses).toEqual(["canceling", "needs_reconcile"]);
  });

  it("allows an explicit exit only after canceled with zero fill", async () => {
    broker.queryRobinhoodOrder.mockResolvedValue({ ok: true, status: "canceled", filledQty: 0 });
    const { supabase, statuses } = db(active);
    const result = await cancelProtectiveStop({ supabase, ...input });
    expect(result.ok).toBe(true);
    expect(statuses).toEqual(["canceling", "canceled"]);
  });

  it("refuses to infer safety from a missing or id-less row", async () => {
    expect((await cancelProtectiveStop({ supabase: db(null).supabase, ...input })).ok).toBe(false);
    expect((await cancelProtectiveStop({ supabase: db({ ...active, broker_order_id: null, status: "placing" }).supabase, ...input })).ok).toBe(false);
    expect(broker.cancelRobinhoodOrder).not.toHaveBeenCalled();
  });
});
