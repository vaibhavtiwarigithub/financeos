import { describe, expect, it, vi } from "vitest";
import { classifyInstrument, persistInstrumentClassification } from "@/lib/scoring/instrument-registry";

describe("instrument registry classification", () => {
  it.each([
    [{ symbol: "AAPL", market: "us", isAdr: false }, "us_equity", "inferred_equity", "inferred"],
    [{ symbol: "INFY", market: "us", isAdr: true }, "adr", "curated_adr", "curated"],
    [{ symbol: "QQQ", market: "us", isAdr: false }, "etf", "curated_static", "curated"],
    [{ symbol: "GLD", market: "us", isAdr: false }, "metal_fund", "curated_static", "curated"],
    [{ symbol: "TQQQ", market: "us", isAdr: false }, "leveraged_or_inverse_etf", "curated_static", "curated"],
    [{ symbol: "RELIANCE.NS", market: "india", isAdr: false }, "india_equity", "market_suffix", "derived"],
  ] as const)("classifies %s without granting an entry permission", (input, kind, source, confidence) => {
    const result = classifyInstrument(input);

    expect(result.instrumentKind).toBe(kind);
    expect(result.source).toBe(source);
    expect(result.confidence).toBe(confidence);
  });

  it("only writes observation fields and preserves database-owned permission defaults", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ upsert });

    await persistInstrumentClassification({ from }, classifyInstrument({ symbol: "AAPL", market: "us", isAdr: false }));

    expect(from).toHaveBeenCalledWith("instrument_registry");
    const [payload, options] = upsert.mock.calls[0];
    expect(payload).toMatchObject({
      market: "us",
      symbol: "AAPL",
      instrument_kind: "us_equity",
      classification_source: "inferred_equity",
      classification_confidence: "inferred",
    });
    expect(payload).not.toHaveProperty("new_entry_allowed");
    expect(payload).not.toHaveProperty("review_status");
    expect(options).toEqual({ onConflict: "market,symbol" });
  });
});
