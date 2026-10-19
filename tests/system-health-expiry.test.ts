import { describe, expect, it } from "vitest";
import { resolveExpiredIssues } from "@/lib/system-health";

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
});
