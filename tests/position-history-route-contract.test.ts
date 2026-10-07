import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VIEWER_API_ROUTES } from "@/lib/auth/roles";

const routePath = resolve(__dirname, "../app/api/portfolio/position-history/route.ts");
const source = readFileSync(routePath, "utf8");

describe("position history endpoint contract", () => {
  it("is explicitly viewer-safe as a persisted read only", () => {
    expect(VIEWER_API_ROUTES).toContainEqual({ prefix: "/api/portfolio/position-history", methods: ["GET"], exact: true });
    expect(source).toContain("requireViewerOrOwner");
    expect(source).toContain('"Cache-Control": "private, no-store"');
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain("POST");
  });

  it("requires market scope and verifies open positions before reading marks", () => {
    expect(source).toContain('.eq("market", market)');
    expect(source).toContain('.select("id, symbol, opened_at")');
    expect(source).not.toContain("created_at");
    expect(source.indexOf('from("paper_positions")')).toBeLessThan(source.indexOf('from("paper_position_marks")'));
    expect(source).toContain('.in("position_id", verifiedIds)');
  });

  it("bounds the batch and paginates to avoid silently returning only the first DB page", () => {
    expect(source).toContain("requestedIds.length > 8");
    expect(source).toContain("PAGE_SIZE = 500");
    expect(source).toContain(".range(offset, offset + PAGE_SIZE - 1)");
    expect(source).toContain('.order("session_date", { ascending: false })');
    expect(source).toContain("value.truncated = true");
  });
});
