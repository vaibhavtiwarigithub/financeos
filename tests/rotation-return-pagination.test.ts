import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const archive = vi.hoisted(() => ({ readOr: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/storage-budget/symbol-daily-returns-archive", () => ({ readSymbolDailyReturnsOr: archive.readOr }));
import { loadRotationReturnCohort } from "@/lib/trading/capital-rotation";
import { measureCandidatePostSwapCorrelation, type RotationReturnRow } from "@/lib/trading/rotation-readiness";

const savedArchiveReads = process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_READS;
beforeEach(() => {
  delete process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_READS;
  archive.read.mockReset();
  archive.readOr.mockImplementation((query: unknown, supabaseRead: () => Promise<unknown[]>, options: unknown) =>
    process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_READS === "true" ? archive.read(query, options) : supabaseRead());
});
afterEach(() => {
  if (savedArchiveReads === undefined) delete process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_READS;
  else process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_READS = savedArchiveReads;
});

describe("rotation return cohort", () => {
  it("reads every RPC page before assessing every held name", async () => {
    const symbols = ["A", ...Array.from({ length: 14 }, (_, i) => `H${String(i + 1).padStart(2, "0")}`)];
    const rows: RotationReturnRow[] = symbols.flatMap((symbol, s) =>
      Array.from({ length: 70 }, (_, i) => ({
        symbol,
        session_date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
        simple_return: ((i * 7 + s) % 17 - 8) / 1000,
        available_at: "2026-04-01T00:00:00Z",
      })),
    );
    const pages: number[] = [];
    const query = {
      order: () => query,
      range: async (from: number, to: number) => {
        pages.push(from);
        return { data: rows.slice(from, to + 1), error: null };
      },
    };
    const supabase = { rpc: (name: string, args: Record<string, unknown>) => {
      expect(name).toBe("get_rotation_return_cohort");
      expect(args.p_symbols).toEqual(symbols);
      return query;
    } };
    const result = await loadRotationReturnCohort(supabase, "india", symbols, "2026-01-01");
    expect(result).toHaveLength(1_050);
    expect(pages).toEqual([0, 1_000]);
    expect(measureCandidatePostSwapCorrelation(result, "A", symbols.slice(1), 60))
      .toMatchObject({ status: "ok", pairCount: 14, expectedPairCount: 14 });
  });

  it("uses the parity-gated D1 reader when explicitly enabled and preserves the RPC row shape", async () => {
    process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_READS = "true";
    archive.read.mockResolvedValue([{ symbol: "AAPL", session_date: "2026-01-02", simple_return: "0.0125",
      available_at: "2026-01-03T15:00:00.123456Z", id: 77 }]);
    const supabase = { rpc: vi.fn(() => { throw new Error("Postgres fallback must not hide archive failure"); }) };
    await expect(loadRotationReturnCohort(supabase, "us", ["AAPL"], "2026-01-01"))
      .resolves.toEqual([{ symbol: "AAPL", session_date: "2026-01-02", simple_return: 0.0125,
        available_at: "2026-01-03T15:00:00.123456Z" }]);
    expect(archive.read).toHaveBeenCalledWith(expect.objectContaining({ market: "us", symbols: ["AAPL"],
      since: "2026-01-01", mode: "rotation" }), { maxRows: 100_000 });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("fails visibly instead of silently falling back when an enabled D1 archive read fails", async () => {
    process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_READS = "true";
    archive.read.mockRejectedValue(new Error("archive is unverified"));
    const supabase = { rpc: vi.fn() };
    await expect(loadRotationReturnCohort(supabase, "us", ["AAPL"], "2026-01-01"))
      .rejects.toThrow("archive is unverified");
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
