import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addCloudflareUserWatchlistItem,
  listCloudflareUserWatchlist,
  removeCloudflareUserWatchlistItem,
} from "@/lib/cloudflare/db-gateway";

const savedUrl = process.env.CLOUDFLARE_DB_GATEWAY_URL;
const savedToken = process.env.CLOUDFLARE_DB_GATEWAY_TOKEN;
const savedFetch = global.fetch;

afterEach(() => {
  if (savedUrl === undefined) delete process.env.CLOUDFLARE_DB_GATEWAY_URL;
  else process.env.CLOUDFLARE_DB_GATEWAY_URL = savedUrl;
  if (savedToken === undefined) delete process.env.CLOUDFLARE_DB_GATEWAY_TOKEN;
  else process.env.CLOUDFLARE_DB_GATEWAY_TOKEN = savedToken;
  global.fetch = savedFetch;
  vi.restoreAllMocks();
});

describe("Cloudflare D1 server gateway", () => {
  it("lists rows through a no-store server request with the authenticated user's ID", async () => {
    process.env.CLOUDFLARE_DB_GATEWAY_URL = "https://kairos-db-gateway.example.workers.dev";
    process.env.CLOUDFLARE_DB_GATEWAY_TOKEN = "gateway-token-with-at-least-32-characters";
    const responseRows = [{ id: "r1", symbol: "AAPL", market: "us", added_at: "2026-01-01T00:00:00.000Z" }];
    const fetch = vi.fn(async () => Response.json({ items: responseRows }));
    global.fetch = fetch as typeof global.fetch;

    await expect(listCloudflareUserWatchlist("abc12345-6789-4abc-8def-0123456789ab")).resolves.toEqual(responseRows);
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/user-watchlist");
    expect(url.searchParams.get("user_id")).toBe("abc12345-6789-4abc-8def-0123456789ab");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer gateway-token-with-at-least-32-characters");
    expect(init.cache).toBe("no-store");
  });

  it("writes only through the server-side gateway and carries no browser credential", async () => {
    process.env.CLOUDFLARE_DB_GATEWAY_URL = "https://kairos-db-gateway.example.workers.dev";
    process.env.CLOUDFLARE_DB_GATEWAY_TOKEN = "gateway-token-with-at-least-32-characters";
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    global.fetch = fetch as typeof global.fetch;

    await addCloudflareUserWatchlistItem({ userId: "abc12345-6789-4abc-8def-0123456789ab", symbol: "AAPL", market: "us" });
    await removeCloudflareUserWatchlistItem({ userId: "abc12345-6789-4abc-8def-0123456789ab", symbol: "AAPL", market: "us" });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [addUrl, addInit] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    const [removeUrl, removeInit] = fetch.mock.calls[1] as unknown as [URL, RequestInit];
    expect(addUrl.pathname).toBe("/v1/user-watchlist");
    expect(addInit.method).toBe("POST");
    expect(JSON.parse(String(addInit.body))).toEqual({ user_id: "abc12345-6789-4abc-8def-0123456789ab", symbol: "AAPL", market: "us" });
    expect(removeUrl.searchParams.get("user_id")).toBe("abc12345-6789-4abc-8def-0123456789ab");
    expect(removeInit.method).toBe("DELETE");
  });

  it("fails closed when the gateway is missing or is not HTTPS", async () => {
    delete process.env.CLOUDFLARE_DB_GATEWAY_URL;
    delete process.env.CLOUDFLARE_DB_GATEWAY_TOKEN;
    await expect(listCloudflareUserWatchlist("abc12345-6789-4abc-8def-0123456789ab")).rejects.toThrow("not configured");

    process.env.CLOUDFLARE_DB_GATEWAY_URL = "http://kairos-db-gateway.example.workers.dev";
    process.env.CLOUDFLARE_DB_GATEWAY_TOKEN = "gateway-token-with-at-least-32-characters";
    await expect(listCloudflareUserWatchlist("abc12345-6789-4abc-8def-0123456789ab")).rejects.toThrow("HTTPS");
  });

  it("does not expose gateway response details to callers", async () => {
    process.env.CLOUDFLARE_DB_GATEWAY_URL = "https://kairos-db-gateway.example.workers.dev";
    process.env.CLOUDFLARE_DB_GATEWAY_TOKEN = "gateway-token-with-at-least-32-characters";
    global.fetch = vi.fn(async () => new Response("private SQL detail", { status: 500 })) as typeof global.fetch;
    await expect(listCloudflareUserWatchlist("abc12345-6789-4abc-8def-0123456789ab")).rejects.toThrow("request failed");
    await expect(listCloudflareUserWatchlist("abc12345-6789-4abc-8def-0123456789ab")).rejects.not.toThrow("private SQL detail");
  });
});
