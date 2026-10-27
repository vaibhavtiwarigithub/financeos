import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { workerTokenHash } from "@/lib/llm-council/subscription";

const mocks = vi.hoisted(() => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.createServiceClient }));

import { POST } from "@/app/api/agents/llm-council/worker/route";

const token = `kcw_${"a".repeat(64)}`;
const auth = `Bearer ${token}`;
const makeRequest = (body: unknown, authorization = auth) => new NextRequest("http://localhost/api/agents/llm-council/worker", {
  method: "POST",
  headers: authorization ? { authorization, "content-type": "application/json" } : { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("LLM council worker route", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("authenticates claim polls inside the existing claim RPC without a token-filter REST request", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const from = vi.fn();
    mocks.createServiceClient.mockReturnValue({ rpc, from });

    const response = await POST(makeRequest({ action: "claim" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ job: null });
    expect(rpc).toHaveBeenCalledWith("council_subscription_claim", { p_token_hash: workerTokenHash(auth) });
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects an unknown worker from the claim RPC without exposing database details", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "unauthorized_worker" } });
    mocks.createServiceClient.mockReturnValue({ rpc, from: vi.fn() });

    const response = await POST(makeRequest({ action: "claim" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects malformed requests before opening a database client", async () => {
    const from = vi.fn();
    const rpc = vi.fn();
    mocks.createServiceClient.mockReturnValue({ rpc, from });

    const response = await POST(makeRequest({ action: "unknown" }));

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
