import { beforeEach, describe, expect, it, vi } from "vitest";

const mirror = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("@/lib/storage-budget/symbol-daily-returns-archive", () => ({ mirrorSymbolDailyReturns: mirror.write }));
import { captureReturnObservation } from "@/lib/data/return-observations";

const input = {
  symbol: "AAPL", market: "us" as const, source: "massive", now: new Date("2026-01-04T12:00:00.000Z"),
  candles: [
    { date: "2026-01-02", open: 99, high: 101, low: 98, close: 100, volume: 1000 },
    { date: "2026-01-03", open: 100, high: 102, low: 99, close: 101, volume: 1200 },
  ],
  benchmark: [],
};

describe("captureReturnObservation archive mirroring", () => {
  beforeEach(() => mirror.write.mockReset().mockResolvedValue({ configured: false, accepted: 0, inserted: 0 }));

  it("mirrors only IDs confirmed inserted by Supabase and avoids numeric round trips", async () => {
    let inserted: Record<string, unknown>[] = [];
    let selectedColumns = "";
    const supabase: any = {
      from(table: string) {
        if (table === "symbol_return_observations") return { insert: async () => ({ error: null }) };
        return {
          upsert(rows: Record<string, unknown>[]) {
            inserted = rows;
            return { async select(columns: string) {
              selectedColumns = columns;
              const row = rows[0];
              return { error: null, data: [{ id: 7, symbol: row.symbol, market: row.market, session_date: row.session_date,
                source: row.source, price_basis: row.price_basis, input_fingerprint: row.input_fingerprint,
                created_at: "2026-01-04T12:00:00+00:00" }] };
            } };
          },
        };
      },
    };
    const result = await captureReturnObservation(supabase, input);
    expect(result?.symbol).toBe("AAPL");
    expect(inserted).toHaveLength(1);
    expect(selectedColumns).toBe("id,symbol,market,session_date,previous_session_date,available_at,source,price_basis,input_fingerprint,created_at");
    const mirrored = mirror.write.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]).toMatchObject({ id: 7, created_at: "2026-01-04T12:00:00+00:00", close: inserted[0].close,
      previous_close: inserted[0].previous_close, simple_return: inserted[0].simple_return });
  });

  it("keeps research capture fail-open if the archive mirror is unavailable", async () => {
    mirror.write.mockRejectedValueOnce(new Error("archive unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const supabase: any = {
        from(table: string) {
          if (table === "symbol_return_observations") return { insert: async () => ({ error: null }) };
          return { upsert(rows: Record<string, unknown>[]) { return { async select() {
            const row = rows[0];
            return { error: null, data: [{ id: 8, symbol: row.symbol, market: row.market, session_date: row.session_date,
              source: row.source, price_basis: row.price_basis, input_fingerprint: row.input_fingerprint,
              created_at: "2026-01-04T12:00:00+00:00" }] };
          } }; } };
        },
      };
      expect((await captureReturnObservation(supabase, input))?.symbol).toBe("AAPL");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("source rows remain in Supabase"));
    } finally { log.mockRestore(); }
  });
});
