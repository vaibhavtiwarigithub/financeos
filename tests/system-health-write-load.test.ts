import { describe, expect, it, vi } from "vitest";
import { reportIssue } from "@/lib/system-health";

const input = { issueKey: "freshness:test", severity: "critical" as const, category: "data", title: "Missing bar", detail: "Requires current session" };
function client(existing: unknown, error: unknown = null) {
  const update = vi.fn();
  const insert = vi.fn(async () => ({ error: null }));
  const filters: unknown[] = [];
  const b: any = {
    select: () => b, eq: (...args: unknown[]) => { filters.push(args); return b; }, limit: () => b,
    maybeSingle: async () => ({ data: existing, error }),
    update: (p: unknown) => { update(p); return b; }, insert,
    then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
  };
  return { svc: { from: () => b } as any, update, insert, filters };
}
describe("health issue idempotence without hiding changes", () => {
  it("does not rewrite an identical open fault", async () => {
    const c = client({ id: "a", ...input, auto_expire_at: null });
    await reportIssue(input, c.svc);
    expect(c.update).not.toHaveBeenCalled();
    expect(c.insert).not.toHaveBeenCalled();
  });
  it("persists a changed fault and guards a concurrently resolved row", async () => {
    const c = client({ id: "a", ...input, title: "Old" });
    await reportIssue(input, c.svc);
    expect(c.update).toHaveBeenCalledWith(expect.objectContaining({ title: input.title }));
    expect(c.filters).toContainEqual(["resolved", false]);
  });
  it("creates an alert if no open row exists", async () => {
    const c = client(null);
    await reportIssue(input, c.svc);
    expect(c.insert).toHaveBeenCalledWith(expect.objectContaining({ issue_key: input.issueKey, resolved: false }));
  });
  it("does not insert on a failed lookup", async () => {
    const c = client(null, { message: "timeout" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { await reportIssue(input, c.svc); expect(c.insert).not.toHaveBeenCalled(); }
    finally { log.mockRestore(); }
  });
  it("recognizes equivalent database timestamp formatting", async () => {
    const c = client({ id: "a", ...input, auto_expire_at: "2026-10-25T00:00:00+00:00" });
    await reportIssue({ ...input, autoExpireAt: "2026-10-25T00:00:00.000Z" }, c.svc);
    expect(c.update).not.toHaveBeenCalled();
  });
});
