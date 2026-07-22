import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { EDGE_BY_ID, EDGES } from "@/lib/edges/registry";
import { normalizeSectorSegment } from "@/lib/edges/ic";
import { computeTechnicals, scoreTechnicals, type Candle } from "@/lib/data/technicals";
import { knownSectorForSymbol } from "@/lib/portfolio-risk";

function candles(count: number, closeAt: (index: number) => number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = closeAt(index);
    return {
      date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      open: close * 0.995,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000 + index * 1_000,
    };
  });
}

function context(series: Candle[]) {
  return { symbol: "TEST", market: "us" as const, asOf: series.at(-1)!.date, candles: series, benchmark: series };
}

describe("technical factor calibration", () => {
  it("represents the exact production technical score without a replica formula", () => {
    const series = candles(90, i => 100 + i * 0.4 + Math.sin(i / 4));
    const edgeValue = EDGE_BY_ID.kairos_technical_score_v1.compute(context(series));
    expect(edgeValue).toBe(scoreTechnicals(computeTechnicals(series)));
  });

  it("computes finite ATR-normalized MACD and signed ADX on sufficient OHLCV", () => {
    const rising = candles(90, i => 80 * Math.exp(i * 0.006 + i * i * 0.000015));
    const falling = candles(90, i => 180 * Math.exp(-i * 0.006 - i * i * 0.00001));
    const macd = EDGE_BY_ID.macd_atr_12_26_9.compute(context(rising));
    const upAdx = EDGE_BY_ID.signed_adx_14.compute(context(rising));
    const downAdx = EDGE_BY_ID.signed_adx_14.compute(context(falling));
    expect(macd).not.toBeNull();
    expect(Number.isFinite(macd)).toBe(true);
    expect(upAdx).toBeGreaterThan(0);
    expect(downAdx).toBeLessThan(0);
  });

  it("abstains when candidate history is insufficient", () => {
    const short = candles(20, i => 100 + i);
    expect(EDGE_BY_ID.macd_atr_12_26_9.compute(context(short))).toBeNull();
    expect(EDGE_BY_ID.signed_adx_14.compute(context(short))).toBeNull();
  });

  it("keeps every formula identity unique so later parameter changes append", () => {
    const ids = EDGES.map(edge => edge.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("kairos_technical_score_v1");
    expect(ids).toContain("macd_atr_12_26_9");
    expect(ids).toContain("signed_adx_14");
  });

  it("admits real equity sectors and rejects non-sector/unknown buckets", () => {
    expect(normalizeSectorSegment("  Consumer   Discretionary ")).toBe("Consumer Discretionary");
    expect(normalizeSectorSegment("Other")).toBeNull();
    expect(normalizeSectorSegment("Diversified Equity")).toBeNull();
    expect(knownSectorForSymbol("AVGO", "us")).toBe("Technology");
    expect(knownSectorForSymbol("RELIANCE.NS", "india")).toBe("Energy");
    expect(knownSectorForSymbol("UNMAPPED", "us")).toBeNull();
  });

  it("persists fingerprinted segments without a scoring or trading write path", () => {
    const route = fs.readFileSync(path.join(process.cwd(), "app/api/agents/edge-ic/route.ts"), "utf8");
    const cleanup = fs.readFileSync(path.join(process.cwd(), "app/api/agents/db-cleanup/route.ts"), "utf8");
    const migration = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260721130000_technical_factor_calibration_segments.sql"), "utf8");
    expect(route).toContain('onConflict: "run_fingerprint"');
    expect(route).toContain('r.segmentType === "market"');
    expect(migration).toContain("edge_ic_history is append-only");
    expect(cleanup).not.toContain("edge_ic_history");
    for (const forbidden of ["agent_signals", "paper_positions", "broker_orders", "strategy_config", "trading_mandates"]) {
      expect(route).not.toContain(`from(\"${forbidden}\")`);
    }
  });

  it("pins Vibe as a non-admitted comparator instead of a runtime dependency", () => {
    const pin = JSON.parse(fs.readFileSync(path.join(process.cwd(), "features/external-research-shadow/VIBE_SOURCE_PIN.json"), "utf8"));
    expect(pin.commit).toBe("a5eb30fd00d6ee71cd5099d15f57de5ae47010ff");
    expect(pin.admissionStatus).toBe("not_admitted");
    expect(pin.allowedUse).toBe("independent_comparator_after_native_baseline");
    expect(pin.excludedSurfaces).toEqual(expect.arrayContaining([
      "agent and swarm runtime",
      "broker connectors and live trading",
      "network data loaders",
    ]));
  });
});
