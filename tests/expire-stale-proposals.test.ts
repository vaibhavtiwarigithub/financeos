import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The sweeper must only close proposals whose approval window has passed, change nothing but status/updated_at, and stay off client roles.
const sql = readFileSync("supabase/migrations/20261014190000_expire_stale_trade_proposals.sql", "utf8");

describe("expire stale trade proposals sweeper", () => {
  it("only expires pending proposals past their approval window", () => {
    expect(sql).toContain("status = 'pending_review'");
    expect(sql).toContain("approval_expires_at < now()");
    expect(sql).toContain("approval_expires_at is not null");
  });
  it("writes nothing but status and updated_at", () => {
    expect(sql).toMatch(/set status = 'expired', updated_at = now\(\)/);
  });
  it("is not callable by client roles and runs every five minutes", () => {
    expect(sql).toContain("revoke all on function public.expire_stale_trade_proposals() from public, anon, authenticated");
    expect(sql).toContain("'*/5 * * * *'");
  });
});
