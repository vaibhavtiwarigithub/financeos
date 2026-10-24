import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  options: null as any,
  user: vi.fn(), grant: vi.fn(), signOut: vi.fn(), create: vi.fn(),
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: (...args: any[]) => {
  mock.create(); mock.options = args[2];
  const query: any = { select: () => query, eq: () => query, maybeSingle: () => mock.grant() };
  return { auth: { getUser: () => mock.user(), signOut: () => mock.signOut() }, from: () => query };
} }));
import { middleware } from "@/middleware";

const owner = { id: "owner", email: "vterminater@gmail.com", email_confirmed_at: "2026-01-01" };
const guest = { id: "guest", email: "viewer@example.test", email_confirmed_at: "2026-01-01" };
const request = (path = "/dashboard", cookie = true) => new NextRequest(`https://example.test${path}`, {
  headers: cookie ? { cookie: "sb-test-auth-token=synthetic-cookie-not-a-real-session" } : {},
});

describe("middleware availability without weakening authorization", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks();
    mock.user.mockResolvedValue({ data: { user: owner }, error: null });
    mock.grant.mockResolvedValue({ data: { revoked_at: null }, error: null });
    mock.signOut.mockResolvedValue({ error: null });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("keeps cookie-free login/cron fast and anonymous private pages blocked", async () => {
    expect((await middleware(request("/login", false))).headers.get("x-middleware-next")).toBe("1");
    expect((await middleware(request("/api/agents/research", false))).headers.get("x-middleware-next")).toBe("1");
    expect((await middleware(request("/dashboard", false))).headers.get("location")).toBe("https://example.test/login");
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("admits a verified owner and retains refreshed session cookies", async () => {
    mock.user.mockImplementation(async () => {
      mock.options.cookies.setAll([{ name: "sb-test-auth-token", value: "refreshed", options: { httpOnly: true } }]);
      return { data: { user: owner }, error: null };
    });
    const response = await middleware(request());
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.cookies.get("sb-test-auth-token")?.value).toBe("refreshed");
    expect(mock.grant).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["/dashboard", "/property", "/admin", "/api/live-portfolio"])("bounds stuck authentication for %s", async (path) => {
    mock.user.mockImplementation(() => new Promise(() => {}));
    const pending = middleware(request(path));
    await vi.advanceTimersByTimeAsync(3000);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mock.signOut).not.toHaveBeenCalled();
  });

  it("lets public login load when a stale cookie's Auth request hangs", async () => {
    mock.user.mockImplementation(() => new Promise(() => {}));
    const pending = middleware(request("/login"));
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).headers.get("x-middleware-next")).toBe("1");
  });

  it("fails a viewer grant read closed without revoking the session", async () => {
    mock.user.mockResolvedValue({ data: { user: guest }, error: null });
    mock.grant.mockResolvedValue({ data: null, error: { message: "database unavailable" } });
    expect((await middleware(request("/dashboard/portfolio"))).status).toBe(503);
    expect(mock.signOut).not.toHaveBeenCalled();
  });

  it("bounds a hanging viewer grant under the same whole-request budget", async () => {
    mock.user.mockResolvedValue({ data: { user: guest }, error: null });
    mock.grant.mockImplementation(() => new Promise(() => {}));
    const pending = middleware(request("/dashboard/portfolio"));
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).status).toBe(503);
  });

  it("preserves viewer allowlists and denies owner-only APIs", async () => {
    mock.user.mockResolvedValue({ data: { user: guest }, error: null });
    expect((await middleware(request("/dashboard/portfolio"))).headers.get("x-middleware-next")).toBe("1");
    expect((await middleware(request("/api/live-portfolio"))).status).toBe(403);
    expect((await middleware(request("/dashboard/settings"))).headers.get("location")).toBe("https://example.test/dashboard/portfolio");
  });

  it("does not confuse a transient Auth error with a missing or invalid session", async () => {
    mock.user.mockResolvedValue({ data: { user: null }, error: { status: 503 } });
    expect((await middleware(request())).status).toBe(503);
    mock.user.mockResolvedValue({ data: { user: null }, error: { status: 401 } });
    expect((await middleware(request())).headers.get("location")).toBe("https://example.test/login");
  });

  it("aborts network requests and ignores late cookie writes after the deadline", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetch);
    mock.user.mockImplementation(() => mock.options.global.fetch("https://auth.example.test/user", {}));
    const req = request();
    const pending = middleware(req);
    await vi.advanceTimersByTimeAsync(3000);
    const response = await pending;
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    mock.options.cookies.setAll([{ name: "sb-test-auth-token", value: "late" }]);
    expect(req.cookies.get("sb-test-auth-token")?.value).toBe("synthetic-cookie-not-a-real-session");
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(mock.options.global.fetch("https://auth.example.test/user", {})).rejects.toThrow("deadline");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
