import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/auth/cron", () => ({ verifyCronSecret: () => false }));
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: async () => null }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => mocks }));
import { GET } from "@/app/api/agents/strategy-replay/route";

describe("strategy replay dry-run authority", () => {
  it("GET never registers trials or writes even on the first request", async () => {
    const query: any = {};
    for (const op of ["select", "in", "order"]) query[op] = () => query;
    query.range = async () => ({ data: [], error: null });
    mocks.from.mockReturnValue(query);
    const response = await GET(new NextRequest("https://test/api/agents/strategy-replay"));
    expect(response.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect((await response.json()).persisted).toBe(false);
  });
});
