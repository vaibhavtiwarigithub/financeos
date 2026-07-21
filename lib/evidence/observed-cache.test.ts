import { describe, expect, it, vi } from "vitest";
import { persistObservedResearchEvidence } from "@/lib/evidence/observed-cache";

describe("persistObservedResearchEvidence", () => {
  it("bridges already-computed US score inputs without an external fetch surface", async () => {
    let writtenRows: Array<Record<string, any>> = [];
    const upsert = vi.fn(async (rows: Array<Record<string, any>>) => {
      writtenRows = rows;
      return { error: null };
    });
    const client = { from: vi.fn(() => ({ upsert })) };
    const candles = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, "0")}`,
      open: 100 + i,
      high: 102 + i,
      low: 99 + i,
      close: 101 + i,
      volume: 1_000 + i,
    }));

    await persistObservedResearchEvidence(client, {
      market: "us",
      symbol: "AAPL",
      runId: "research-1",
      isEtf: false,
      overview: { Symbol: "AAPL", PERatio: "24", ProfitMargin: "0.2", ReturnOnEquityTTM: "0.3" },
      candles,
      scores: {
        fundamental_score: 72,
        technical_score: 68,
        sentiment_score: 61,
        macro_score: 64,
        insider_score: 55,
        evidence: {
          fundamental: { pe: 24 }, technical: { rsi14: 58 }, sentiment: { score: 61 },
          macro: { regime: "GREEN", as_of: "2026-06-20" }, insider: { score: 55 },
        },
        dataQuality: {
          fundamentalDataAvailable: true, technicalDataPoints: 20,
          sentimentDataAvailable: true, macroDataAvailable: true, insiderDataAvailable: true,
        },
      },
      sources: { fundamental: "yahoo", technical: "massive", sentiment: "gdelt", insider: "sec_edgar" },
    });

    expect(client.from).toHaveBeenCalledWith("evidence_cache_v2");
    const rows = writtenRows;
    expect(rows.map((row) => row.intent).sort()).toEqual([
      "fundamentals.reported", "insider.transactions", "macro.regime_inputs", "price.daily_bars", "sentiment.news",
    ].sort());
    expect(rows.every((row) => row.provider_id === "kairos")).toBe(true);
    expect(rows.find((row) => row.intent === "macro.regime_inputs")?.symbol).toBe("__MARKET__");
    expect(rows.find((row) => row.intent === "price.daily_bars")?.payload.dimensionScore).toBe(68);
  });
});
