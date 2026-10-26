import { describe, expect, it, vi } from "vitest";
import { readLeveragedJournalDecisions } from "@/lib/research/leveraged-journal";
const now = new Date("2026-10-26T21:00:00Z");
function fixture(data: unknown, error: unknown = null) {
  const calls: Array<[string, ...unknown[]]> = [];
  const q: any = {};
  for (const name of ["select", "eq", "gte", "lte", "not", "order", "limit"]) q[name] = (...args: unknown[]) => { calls.push([name, ...args]); return q; };
  q.maybeSingle = vi.fn().mockResolvedValue({ data, error });
  return { svc: { from: vi.fn(() => q) }, calls };
}
describe("separate intraday journal evidence", () => {
  it("preserves funding shortfall without inventing legacy amounts and scopes exact symbol/day", async () => {
    const f = fixture({ started_at: "2026-10-26T14:55:00Z", status: "done", result_summary: JSON.stringify({ status: "no_entry", reason: "below_minimum_entry", funding: { availableNotional: 0.0005, minimumNotional: 49, shortfall: 48.9995 } }) });
    const result = await readLeveragedJournalDecisions(f.svc, ["SOXL", "SOXL", "INFY.NS"], "2026-10-26", now);
    expect(f.svc.from).toHaveBeenCalledTimes(1);
    expect(result.bySymbol.get("SOXL").funding.shortfall).toBe(48.9995);
    expect(f.calls).toContainEqual(["eq", "agent_type", "soxl_cron"]);
    expect(f.calls).toContainEqual(["gte", "started_at", "2026-10-26T09:00:00.000Z"]);
    expect(f.calls).toContainEqual(["lte", "started_at", now.toISOString()]);
    expect(f.calls).toContainEqual(["not", "result_summary", "like", '%"reason":"outside_entry_window"%']);
  });
  it("keeps old incomplete logs incomplete and malformed/query failures visible", async () => {
    const old = fixture({ started_at: "2026-10-26T14:55:00Z", status: "done", result_summary: '{"status":"no_entry","reason":"below_minimum_entry"}' });
    expect((await readLeveragedJournalDecisions(old.svc, ["SOXL"], "2026-10-26", now)).bySymbol.get("SOXL").funding).toBeNull();
    const broken = fixture({ started_at: "2026-10-26T14:55:00Z", result_summary: "{" });
    expect((await readLeveragedJournalDecisions(broken.svc, ["SOXL"], "2026-10-26", now)).failed).toBe(true);
    expect((await readLeveragedJournalDecisions(fixture(null, { message: "offline" }).svc, ["SOXL"], "2026-10-26", now)).failed).toBe(true);
  });
});
