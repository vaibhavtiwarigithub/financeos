import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const h = vi.hoisted(() => ({ error: null as any, owner: null as any, cron: false, from: vi.fn(), rpc: vi.fn(), report: vi.fn(), resolve: vi.fn(), queries: [] as any[] }));
vi.mock("@/lib/system-health", () => ({ reportIssue: h.report, resolveIssue: h.resolve }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ from: h.from, rpc: h.rpc }) }));
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: async () => h.owner }));
vi.mock("@/lib/auth/cron", () => ({ verifyCronSecret: () => h.cron }));
import { GET, POST } from "@/app/api/agents/db-cleanup/route";
beforeEach(() => {
  h.error = null; h.owner = null; h.cron = false; h.from.mockReset(); h.rpc.mockReset(); h.queries = [];
  h.report.mockReset(); h.resolve.mockReset();
  h.from.mockImplementation((table: string) => {
    const b: any = {};
    const calls: any[] = [];
    h.queries.push({ table, calls });
    for (const method of ["select", "delete", "eq", "lt", "or", "neq", "order", "limit"]) b[method] = (...args: any[]) => { calls.push([method, ...args]); return b; };
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
  it("expires only stale provider cache by its freshness bound and previews real production timestamp columns", async () => {
    const res = await GET(new NextRequest("https://kairos.test/api/agents/db-cleanup"));
    expect(res.status).toBe(200);
    const cachePreview = h.queries.find(q => q.table === "av_cache");
    expect(cachePreview.calls).toContainEqual(["select", "cache_key", { count: "exact", head: true }]);
    expect(cachePreview.calls.some(([method, column]: any[]) => method === "lt" && column === "fetched_at")).toBe(true);
    expect(cachePreview.calls.some(([method, filter]: any[]) => method === "or" && filter.includes("YAHOO_CANDLES:%") && filter.includes("ALPACA_IEX_5MIN:%"))).toBe(true);

    h.queries = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await POST(new NextRequest("https://kairos.test/api/agents/db-cleanup", { method: "POST" }));
    } finally { log.mockRestore(); }
    const expectedExpiryColumns = [
      ["av_cache", "fetched_at"],
      ["agent_runs", "started_at"],
      ["macro_signals", "created_at"],
      ["macro_regime", "created_at"],
      ["rag_traces", "ts"],
      ["india_screen_cache", "scored_at"],
      ["learning_priors_history", "changed_at"],
    ];
    for (const [table, column] of expectedExpiryColumns) {
      const query = h.queries.find(q => q.table === table && q.calls.some(([method]: any[]) => method === "delete"));
      expect(query?.calls.some(([method, candidate]: any[]) => method === "lt" && candidate === column), `${table} must use ${column}`).toBe(true);
    }
    const candleCleanup = h.queries.find(q => q.table === "av_cache" && q.calls.some(([method, value]: any[]) => method === "or" && String(value).includes("YAHOO_CANDLES:%")));
    expect(candleCleanup?.calls).toContainEqual(["lt", "fetched_at", expect.any(String)]);
    const cacheDeletes = h.queries.filter(q => q.table === "av_cache" && q.calls.some(([method]: any[]) => method === "delete"));
    expect(cacheDeletes).toHaveLength(2);
    for (const query of cacheDeletes) {
      expect(query.calls).toContainEqual(["order", "cache_key"]);
      expect(query.calls).toContainEqual(["order", "cache_date"]);
      expect(query.calls).toContainEqual(["limit", 2000]);
    }
  });
  it("refuses unauthenticated callers before touching the database", async () => {
    h.cron = false; h.owner = new Response(null, { status: 401 });
    expect((await POST(new NextRequest("https://kairos.test/api/agents/db-cleanup", { method: "POST" }))).status).toBe(401);
    expect(h.from).not.toHaveBeenCalled();
  });
  it("runs the Vercel GET cron only with its authenticated bearer secret", async () => {
    h.owner = new Response(null, { status: 401 });
    const request = new NextRequest("https://kairos.test/api/agents/db-cleanup", { headers: { authorization: "Bearer scheduled-secret" } });
    expect((await GET(request)).status).toBe(401);
    expect(h.from).not.toHaveBeenCalled();
    h.cron = true;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await GET(request);
      expect(response.status).toBe(200);
      expect((await response.json()).totalDeleted).toBe(0);
      expect(h.queries.some(q => q.calls.some(([method]: string[]) => method === "delete"))).toBe(true);
      expect(h.resolve).toHaveBeenCalledWith("db-cleanup-failed");
    } finally { log.mockRestore(); }
  });
});
