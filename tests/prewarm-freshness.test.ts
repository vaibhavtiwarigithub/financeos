import { describe, expect, it } from "vitest";
import { prewarmPriceCache } from "@/lib/chart-data";

describe("price-cache prewarm admission", () => {
  it("returns immediately for an empty symbol list", async () => {
    const supabase = { from: () => { throw new Error("must not query"); } };
    await expect(prewarmPriceCache([], supabase)).resolves.toEqual({
      ok: 0, failed: 0, skipped: 0, alreadyFresh: 0,
    });
  });

  it("does not spend provider budget on symbols already fresh in cache", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const query: any = {
      select: () => query,
      in: () => query,
      gte: () => query,
      limit: async () => ({ data: [
        { symbol: "AAPL", date: today },
        { symbol: "MSFT", date: today },
      ], error: null }),
    };
    const supabase = { from: () => query };
    const result = await prewarmPriceCache(["aapl", "AAPL", "MSFT"], supabase);
    expect(result).toEqual({ ok: 2, failed: 0, skipped: 0, alreadyFresh: 2 });
  });
});
