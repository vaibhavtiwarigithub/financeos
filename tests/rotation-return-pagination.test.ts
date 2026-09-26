import { describe, expect, it } from "vitest";
import { loadRotationReturnCohort } from "@/lib/trading/capital-rotation";
import { measureCandidatePostSwapCorrelation, type RotationReturnRow } from "@/lib/trading/rotation-readiness";

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
});
