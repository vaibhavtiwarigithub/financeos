import { describe, expect, it, vi } from "vitest";
import { loadBenchmarkHistory } from "@/lib/analytics/benchmark-history";

function client(rows: unknown[], failOffset = -1) {
  const query: any = {};
  for (const method of ["select", "eq", "order"]) query[method] = vi.fn(() => query);
  query.range = vi.fn(async (start: number, end: number) => start === failOffset
    ? { data: null, error: { message: "unavailable" } }
    : { data: rows.slice(start, end + 1), error: null });
  return { from: vi.fn(() => query), query };
}
describe("benchmark history pagination", () => {
  it("includes newer observations beyond the old 500-row cutoff", async () => {
    const rows = Array.from({ length: 507 }, (_, index) => ({
      date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
      close: 100 + index, component_symbol: "VOO",
    }));
    const svc = client(rows);
    const result = await loadBenchmarkHistory(svc, "voo");
    expect(result).toHaveLength(507);
    expect(result.at(-1)).toEqual({ date: rows[506].date, level: 606 });
    expect(svc.query.range.mock.calls).toEqual([[0, 499], [500, 999]]);
  });
  it("does not publish a truncated series when a later page fails", async () => {
    await expect(loadBenchmarkHistory(client(Array(500).fill({ date: "2026-09-11", close: 100 }), 500), "voo"))
      .rejects.toThrow("benchmark history read failed");
  });
  it("terminates on an empty final page after an exact multiple", async () => {
    const svc = client(Array(500).fill({ date: "2026-09-11", close: 100 }));
    expect(await loadBenchmarkHistory(svc, "voo")).toHaveLength(500);
    expect(svc.query.range).toHaveBeenCalledTimes(2);
  });
});
