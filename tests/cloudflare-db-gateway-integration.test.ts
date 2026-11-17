import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const route = readFileSync(resolve(__dirname, "../app/api/user-watchlist/route.ts"), "utf8");
const gateway = readFileSync(resolve(__dirname, "../lib/cloudflare/db-gateway.ts"), "utf8");
const migration = readFileSync(resolve(__dirname, "../cloudflare/d1/app-migrations/0001_user_watchlist.sql"), "utf8");

describe("user watchlist Cloudflare D1 cutover slice", () => {
  it("keeps the existing session role as the only source of the row owner", () => {
    expect(route.match(/getSessionRole\(\)/g)?.length).toBe(3);
    expect(route).not.toMatch(/body\??\.user_id|body\??\.userId/);
    expect(route).toContain("addCloudflareUserWatchlistItem({ userId, symbol, market })");
    expect(route).toContain("listCloudflareUserWatchlist(userId)");
    expect(route).toContain("removeCloudflareUserWatchlistItem({ userId, symbol, market })");
  });

  it("uses server-only credentials over HTTPS and disables caching", () => {
    expect(gateway).toContain('import "server-only"');
    expect(gateway).toContain('baseUrl.protocol !== "https:"');
    expect(gateway).toContain('cache: "no-store"');
    expect(gateway).toContain("CLOUDFLARE_DB_GATEWAY_TOKEN");
    expect(gateway).not.toContain("NEXT_PUBLIC_CLOUDFLARE_DB_GATEWAY_TOKEN");
  });

  it("preserves the PostgreSQL owner key, unique key, market check, and ordering index", () => {
    expect(migration).toContain("user_id TEXT NOT NULL");
    expect(migration).toContain("CHECK (market IN ('us', 'india'))");
    expect(migration).toContain("UNIQUE (user_id, symbol, market)");
    expect(migration).toContain("ON user_watchlist (user_id, added_at DESC)");
  });
});
