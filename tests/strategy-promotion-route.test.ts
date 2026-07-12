import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc: h.rpc, from: h.from }) }));

import { POST } from "@/app/api/strategies/versions/route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/strategies/versions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("strategy champion promotion route", () => {
  beforeEach(() => { h.rpc.mockReset(); h.from.mockReset(); });

  it("rejects invalid ids before touching the database", async () => {
    const res = await POST(request({ action: "promote_champion", version_id: 0 }));
    expect(res.status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("rejects the former unvalidated bypass", async () => {
    const res = await POST(request({ action: "promote_champion", version_id: 2, force_unvalidated: true }));
    expect(res.status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("delegates the entire mutation to the atomic RPC, never route-level updates", async () => {
    h.rpc.mockResolvedValue({ data: { promoted: 2, market: "india" }, error: null });
    const res = await POST(request({ action: "promote_champion", version_id: 2 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, promoted: 2, market: "india" });
    expect(h.rpc).toHaveBeenCalledWith("promote_strategy_champion", { p_version_id: 2 });
    expect(h.from).not.toHaveBeenCalled();
  });

  it("fails closed when validation is absent", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "passed validation is required" } });
    const res = await POST(request({ action: "promote_champion", version_id: 2 }));
    expect(res.status).toBe(412);
  });
});
