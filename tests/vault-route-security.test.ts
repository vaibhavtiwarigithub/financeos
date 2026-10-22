import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: vi.fn() }));
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { GET, POST } from "@/app/api/admin/vault/route";

const url = "https://kairos.test/api/admin/vault";
const request = (headers: Record<string, string> = {}, body = '{"action":"toggle","key_name":"TEST","enabled":false}') =>
  new NextRequest(url, { method: "POST", headers: { origin: "https://kairos.test", "content-type": "application/json", ...headers }, body });

describe("vault response and mutation boundary", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(requireOwner).mockResolvedValue(null); });
  it("returns only allowlisted fields and masked values even if DB adds secret columns", async () => {
    const select = vi.fn().mockReturnValue({ order: vi.fn().mockResolvedValue({ data: [{ id: "test", key_name: "NOT_AN_ENV_SECRET", key_value: "synthetic-secret-long", display_name: "Test", future_secret: "do-not-return" }], error: null }) });
    vi.mocked(createServiceClient).mockReturnValue({ from: () => ({ select }) } as any);
    const res = await GET();
    const json = await res.json();
    expect(select.mock.calls[0][0]).not.toBe("*");
    expect(json.keys[0].key_value).not.toBe("synthetic-secret-long");
    expect(json.keys[0]).not.toHaveProperty("future_secret");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each([
    [{ origin: "https://evil.test" }, 403],
    [{ origin: "null" }, 403],
    [{ "sec-fetch-site": "cross-site" }, 403],
    [{ "content-type": "text/plain" }, 415],
  ])("rejects untrusted browser requests before service access", async (headers, status) => {
    expect((await POST(request(headers as Record<string, string>))).status).toBe(status);
    expect(createServiceClient).not.toHaveBeenCalled();
  });
  it("handles malformed JSON without opening the service client", async () => {
    expect((await POST(request({}, "not json"))).status).toBe(400);
    expect(createServiceClient).not.toHaveBeenCalled();
  });
  it("requires the owner before validating requests or reading keys", async () => {
    vi.mocked(requireOwner).mockResolvedValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
    expect((await GET()).status).toBe(403);
    expect((await POST(request())).status).toBe(403);
    expect(createServiceClient).not.toHaveBeenCalled();
  });
  it("keeps a same-origin owner JSON toggle functional", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    vi.mocked(createServiceClient).mockReturnValue({ from: () => ({ update }) } as any);
    expect((await POST(request())).status).toBe(200);
    expect(update).toHaveBeenCalledWith({ enabled: false });
  });
});
