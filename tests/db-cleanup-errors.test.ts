import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const h = vi.hoisted(() => ({ error: null as any, owner: null as any, cron: true, from: vi.fn(), rpc: vi.fn(), report: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/system-health", () => ({ reportIssue: h.report, resolveIssue: h.resolve }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ from: h.from, rpc: h.rpc }) }));
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: async () => h.owner }));
vi.mock("@/lib/auth/cron", () => ({ verifyCronSecret: () => h.cron }));
import { GET, POST } from "@/app/api/agents/db-cleanup/route";
beforeEach(() => {
  h.error = null; h.owner = null; h.cron = true; h.from.mockReset(); h.rpc.mockReset();
  h.report.mockReset(); h.resolve.mockReset();
  h.from.mockImplementation(() => {
    const b: any = {};
    for (const method of ["select", "delete", "eq", "lt", "neq", "order", "limit"]) b[method] = () => b;
    b.maybeSingle = async () => ({ data: { id: "latest" }, error: h.error });
    b.then = (resolve: any) => Promise.resolve({ count: 0, error: h.error }).then(resolve);
    return b;
  });
  h.rpc.mockImplementation(async () => ({ data: 0, error: h.error }));
});
describe("cleanup never mistakes a returned database error for success", () => {
  it("marks failed deletes and missing RPCs as failure", async () => {
    h.error = { message: "statement timeout" };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await POST(new NextRequest("https://kairos.test/api/agents/db-cleanup", { method: "POST" }));
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(Object.values(data.results).every(n => n === -1)).toBe(true);
      expect(h.report).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "db-cleanup-failed" }));
      expect(h.resolve).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it("marks a failed read-only preview as unavailable", async () => {
    h.error = { message: "timeout" };
    const res = await GET(new NextRequest("https://kairos.test/api/agents/db-cleanup"));
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });
  it("keeps a genuine zero-row cleanup successful", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await POST(new NextRequest("https://kairos.test/api/agents/db-cleanup", { method: "POST" }));
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
      expect(h.resolve).toHaveBeenCalledWith("db-cleanup-failed");
    } finally { log.mockRestore(); }
  });
  it("refuses unauthenticated callers before touching the database", async () => {
    h.cron = false; h.owner = new Response(null, { status: 401 });
    expect((await POST(new NextRequest("https://kairos.test/api/agents/db-cleanup", { method: "POST" }))).status).toBe(401);
    expect(h.from).not.toHaveBeenCalled();
  });
});
