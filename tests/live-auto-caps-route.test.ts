import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// THE DEFECT THIS GUARDS.
//
// The Settings form sends `field || null` for an empty input, so a blank box
// arrives as null. The two USD caps handled that (`val !== null && ...`), but
// the confidence and the two count caps did not: `Number(null)` coerced to 0,
// which then failed the 0.6 evidence floor and the 1..N range checks.
//
// Effect: Save Caps was unusable unless all three boxes were filled, and the
// error blamed a value the owner never entered —
// "live_auto_min_evidence_confidence cannot be below 0.6 for autonomous path"
// for a field left empty. Production strategy_config sat at
// min_evidence_confidence=null and max_open_positions=null because no save
// containing them could ever succeed.
//
// null is a value the execution kernel already understands: it reads
// `live_auto_min_evidence_confidence ?? 0.6` and guards both count caps with
// `!= null`. The API was the only layer rejecting it.

const h = vi.hoisted(() => ({ update: vi.fn(), from: vi.fn(), insert: vi.fn() }));

vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: vi.fn(async () => null) }));
vi.mock("@/lib/autonomy", () => ({ AUTONOMOUS_LIVE_ENABLED: true }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      h.from(table);
      if (table === "strategy_config") {
        return {
          select: () => ({
            limit: () => ({ single: async () => ({ data: { id: 1, live_auto_enabled: false, live_auto_mode_us: "autonomous", live_auto_mode_india: "manual" } }) }),
          }),
          update: (patch: Record<string, unknown>) => {
            h.update(patch);
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      return { insert: async (row: unknown) => { h.insert(row); return { error: null }; } };
    },
  }),
}));

import { PATCH } from "@/app/api/settings/live-auto/route";

const patch = (body: unknown) =>
  PATCH(new NextRequest("http://localhost/api/settings/live-auto", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

beforeEach(() => { h.update.mockReset(); h.from.mockReset(); h.insert.mockReset(); });

describe("update_caps accepts a blank field as 'unset'", () => {
  it("saves when every optional cap is left empty — the reported bug", async () => {
    const res = await patch({
      action: "update_caps",
      live_auto_daily_cap_usd: 200,
      live_auto_max_per_order_usd: 100,
      live_auto_min_evidence_confidence: null,
      live_auto_max_open_positions: null,
      live_auto_max_orders_per_day: null,
    });
    expect(res.status).toBe(200);
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({
      live_auto_min_evidence_confidence: null,
      live_auto_max_open_positions: null,
      live_auto_max_orders_per_day: null,
    }));
  });

  it("clears one cap without disturbing the others", async () => {
    const res = await patch({
      action: "update_caps",
      live_auto_min_evidence_confidence: null,
      live_auto_max_orders_per_day: 2,
    });
    expect(res.status).toBe(200);
    const saved = h.update.mock.calls[0][0];
    expect(saved.live_auto_min_evidence_confidence).toBeNull();
    expect(saved.live_auto_max_orders_per_day).toBe(2);
    expect(saved).not.toHaveProperty("live_auto_max_open_positions");
  });

  it("an omitted field is not written at all", async () => {
    await patch({ action: "update_caps", live_auto_daily_cap_usd: 200 });
    const saved = h.update.mock.calls[0][0];
    expect(saved).not.toHaveProperty("live_auto_min_evidence_confidence");
    expect(saved).not.toHaveProperty("live_auto_max_open_positions");
  });
});

describe("the real floors still hold for values actually entered", () => {
  it("still rejects a confidence below the 0.6 autonomous floor", async () => {
    const res = await patch({ action: "update_caps", live_auto_min_evidence_confidence: 0.4 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("below 0.6");
    expect(h.update).not.toHaveBeenCalled();
  });

  it("still rejects a confidence outside 0-1", async () => {
    expect((await patch({ action: "update_caps", live_auto_min_evidence_confidence: 1.5 })).status).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("accepts a confidence at the floor", async () => {
    const res = await patch({ action: "update_caps", live_auto_min_evidence_confidence: 0.6 });
    expect(res.status).toBe(200);
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ live_auto_min_evidence_confidence: 0.6 }));
  });

  it("still rejects out-of-range position and order caps", async () => {
    expect((await patch({ action: "update_caps", live_auto_max_open_positions: 0 })).status).toBe(400);
    expect((await patch({ action: "update_caps", live_auto_max_open_positions: 21 })).status).toBe(400);
    expect((await patch({ action: "update_caps", live_auto_max_orders_per_day: 0 })).status).toBe(400);
    expect((await patch({ action: "update_caps", live_auto_max_orders_per_day: 11 })).status).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("still rejects a non-integer position cap", async () => {
    expect((await patch({ action: "update_caps", live_auto_max_open_positions: 3.5 })).status).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });
});
