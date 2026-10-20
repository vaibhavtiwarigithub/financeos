import { describe, expect, it } from "vitest";
import { resolveExpiredIssues, resolveStaleInformationalIssues } from "@/lib/system-health";

describe("System Health auto-expiry", () => {
  it("resolves only open notices whose explicit expiry has passed", async () => {
    const calls: Array<{ table: string; operation: string; payload?: unknown; filters: unknown[] }> = [];
    const client = {
      from(table: string) {
        const call = { table, operation: "select", payload: undefined as unknown, filters: [] as unknown[] };
        calls.push(call);
        const builder: any = {
          update: (payload: unknown) => { call.operation = "update"; call.payload = payload; return builder; },
          eq: (...args: unknown[]) => { call.filters.push(["eq", ...args]); return builder; },
          not: (...args: unknown[]) => { call.filters.push(["not", ...args]); return builder; },
          lte: (...args: unknown[]) => { call.filters.push(["lte", ...args]); return builder; },
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve({ error: null }).then(resolve, reject),
        };
        return builder;
      },
    };
    const now = new Date("2026-10-19T20:00:00.000Z");

    await resolveExpiredIssues(client as any, now);

    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("agent_alerts");
    expect(calls[0].operation).toBe("update");
    expect(calls[0].payload).toEqual({ resolved: true, resolved_at: now.toISOString() });
    expect(calls[0].filters).toContainEqual(["eq", "resolved", false]);
    expect(calls[0].filters).toContainEqual(["not", "auto_expire_at", "is", null]);
    expect(calls[0].filters).toContainEqual(["lte", "auto_expire_at", now.toISOString()]);
  });

  it("archives old informational notices but preserves owner actions", async () => {
    const calls: Array<{ table: string; operation: string; payload?: unknown; filters: unknown[] }> = [];
    const rows = [
      { id: "stale-info", severity: "info", category: "data", title: "Old evidence notice", detail: null },
      { id: "owner-action", severity: "info", category: "broker", title: "Reconnect broker", detail: null },
    ];
    const client = {
      from(table: string) {
        const call = { table, operation: "select", payload: undefined as unknown, filters: [] as unknown[] };
        calls.push(call);
        const builder: any = {
          select: () => builder,
          update: (payload: unknown) => { call.operation = "update"; call.payload = payload; return builder; },
          eq: (...args: unknown[]) => { call.filters.push(["eq", ...args]); return builder; },
          in: (...args: unknown[]) => { call.filters.push(["in", ...args]); return builder; },
          lt: (...args: unknown[]) => { call.filters.push(["lt", ...args]); return builder; },
          or: (...args: unknown[]) => { call.filters.push(["or", ...args]); return builder; },
          order: (...args: unknown[]) => { call.filters.push(["order", ...args]); return builder; },
          limit: () => builder,
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(call.operation === "select" ? { data: rows, error: null } : { error: null }).then(resolve, reject),
        };
        return builder;
      },
    };
    const now = new Date("2026-10-20T20:00:00.000Z");

    await resolveStaleInformationalIssues(client as any, now);

    expect(calls).toHaveLength(2);
    expect(calls[0].filters).toContainEqual(["in", "severity", ["info", "success"]]);
    expect(calls[0].filters).toContainEqual(["lt", "created_at", "2026-09-20T20:00:00.000Z"]);
    expect(calls[0].filters).toContainEqual(["or", "auto_expire_at.is.null,auto_expire_at.lte.2026-10-20T20:00:00.000Z"]);
    expect(calls[1].payload).toEqual({ resolved: true, resolved_at: now.toISOString() });
    expect(calls[1].filters).toContainEqual(["in", "id", ["stale-info"]]);
  });
});
