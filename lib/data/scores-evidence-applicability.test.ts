import { describe, expect, it, vi } from "vitest";
import { computeScores } from "@/lib/data/scores";

const candles = Array.from({ length: 20 }, (_, index) => ({
  date: `2026-07-${String(index + 1).padStart(2, "0")}`,
  close: 100 + index,
  high: 101 + index,
  low: 99 + index,
  open: 100 + index,
  volume: 1_000_000,
}));

function evidenceClient() {
  const inserted: any[] = [];
  const builder: any = {
    select: () => builder,
    order: () => builder,
    limit: () => Promise.resolve({ data: [], error: null }),
    insert: (rows: any) => {
      inserted.push(...(Array.isArray(rows) ? rows : [rows]));
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { client: { from: vi.fn(() => builder) }, inserted };
}

describe("score evidence applicability", () => {
  it("does not record an empty company-fundamental observation for an ETF", async () => {
    const { client, inserted } = evidenceClient();

    await computeScores({
      symbol: "QQQ",
      isEtf: true,
      avOverview: {},
      candles,
      socialResult: null,
      insiderResult: null,
      supabase: client,
      market: "us",
      now: new Date("2026-07-26T15:00:00Z"),
    });

    expect(inserted.some((row) => row.evidence_type === "fundamental")).toBe(false);
    expect(inserted.some((row) => row.evidence_type === "ohlcv")).toBe(true);
  });
});
