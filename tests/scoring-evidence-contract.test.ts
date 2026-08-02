import { describe, expect, it, vi } from "vitest";
import { computeScores } from "@/lib/data/scores";

const candles = Array.from({ length: 60 }, (_, index) => ({
  date: `2026-06-${String((index % 28) + 1).padStart(2, "0")}`,
  open: 100 + index,
  high: 101 + index,
  low: 99 + index,
  close: 100 + index,
  volume: 1_000_000,
}));

function serviceClient() {
  const query: any = {
    select: () => query,
    order: () => query,
    limit: () => Promise.resolve({ data: [], error: null }),
    insert: () => Promise.resolve({ data: null, error: null }),
  };
  return { from: vi.fn(() => query) };
}

describe("research score evidence contract", () => {
  it("records the exact completed-session price and RSI(14) evidence", async () => {
    const result = await computeScores({
      symbol: "TEST",
      isEtf: false,
      avOverview: { Symbol: "TEST", Sector: "Technology", PERatio: "20", ProfitMargin: "0.2" },
      candles,
      socialResult: { has_data: false },
      insiderResult: null,
      supabase: serviceClient(),
      market: "us",
      now: new Date("2026-07-01T00:00:00Z"),
    });

    expect(result.evidence.technical).toMatchObject({
      rsi14: expect.any(Number),
      price: 159,
      as_of: candles[candles.length - 1].date,
      dataPoints: 60,
    });
  });
});
