import { describe, expect, it } from "vitest";
import { __resetBenchmarkCache, getBenchmarkSeriesStatus } from "@/lib/data/benchmark-series";

// 303 trading-day rows like production SPY (2025-07-22 .. 2026-10-02). Honors the requested order and limit.
function fakeSupabase(rowCount: number) {
  const start = Date.UTC(2025, 6, 22);
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10), close: String(500 + i),
  }));
  const query: any = { ascending: true, max: Infinity };
  const builder: any = {
    select: () => builder, eq: () => builder,
    order: (_col: string, opts: { ascending: boolean }) => { query.ascending = opts.ascending; return builder; },
    limit: (n: number) => {
      const ordered = [...rows].sort((a, b) => (query.ascending ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));
      return Promise.resolve({ data: ordered.slice(0, n), error: null });
    },
  };
  return { client: { from: () => builder }, rows };
}

describe("US benchmark series reads the NEWEST 260 bars (SPY froze at 2026-08-03 and nulled beta/RS for two months)", () => {
  it("returns the latest bar, oldest-first, even when the cache holds more than 260 rows", async () => {
    __resetBenchmarkCache();
    const { client, rows } = fakeSupabase(303);
    const status = await getBenchmarkSeriesStatus("us", client);
    expect(status.bars).toHaveLength(260);
    expect(status.bars.at(-1)!.date).toBe(rows.at(-1)!.date);
    expect(status.asOf).toBe(rows.at(-1)!.date);
    expect(status.bars[0].date < status.bars[1].date).toBe(true);
    expect(status.bars[0].date).toBe(rows[303 - 260].date);
  });
  it("is unchanged for a short cache (all rows, oldest-first)", async () => {
    __resetBenchmarkCache();
    const { client, rows } = fakeSupabase(120);
    const status = await getBenchmarkSeriesStatus("us", client);
    expect(status.bars).toHaveLength(120);
    expect(status.bars[0].date).toBe(rows[0].date);
  });
});
