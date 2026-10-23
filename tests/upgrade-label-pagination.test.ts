import { describe, expect, it } from "vitest";
import { loadLabelCoverageRows } from "@/lib/shadows/status";

function client(pages: Array<{ data: any[] | null; error: any }>) {
  const cursors: Array<number | null> = []; let calls = 0;
  return { cursors, get calls() { return calls; }, svc: { from() {
    let cursor: number | null = null;
    const q: any = { select: () => q, eq: () => q, lte: () => q, order: () => q, limit: () => q,
      gt: (_: string, id: number) => { cursor = id; return q; },
      then: (resolve: (value: unknown) => unknown) => { cursors.push(cursor); return Promise.resolve(pages[calls++]).then(resolve); },
    }; return q;
  } } };
}
const page = (first: number, size = 1000) => ({ data: Array.from({ length: size }, (_, i) => ({ id: first + i })), error: null });
describe("bounded h10 label keyset reads", () => {
  it("seeks past the previous immutable id without rescanning OFFSET prefixes", async () => {
    const c = client([page(1), page(1001), page(2001, 3)]);
    const result = await loadLabelCoverageRows(c.svc, "us");
    expect(result.error).toBeNull(); expect(result.data).toHaveLength(2003);
    expect(c.cursors).toEqual([null, 1000, 2000]);
  });
  it("fails closed on an interrupted or non-advancing cursor", async () => {
    const failed = await loadLabelCoverageRows(client([page(1), { data: null, error: { message: "Timeout" } }]).svc, "india");
    expect(failed.data).toBeNull(); expect(failed.error?.message).toBe("Timeout");
    const repeated = await loadLabelCoverageRows(client([page(1), page(1)]).svc, "us");
    expect(repeated.error?.message).toContain("cursor did not advance");
  });
  it("retains the explicit 20,000-row safety bound", async () => {
    const c = client(Array.from({ length: 20 }, (_, i) => page(i * 1000 + 1)));
    const result = await loadLabelCoverageRows(c.svc, "us");
    expect(c.calls).toBe(20); expect(result.data).toBeNull(); expect(result.error?.message).toContain("bounded 20000-row");
  });
});
