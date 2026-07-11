import { describe, it, expect } from "vitest";
import { computeCorrelationClusters } from "@/lib/risk/correlation";
import type { Candle } from "@/lib/data/technicals";

// Build a candle series from a return path (close-to-close), starting at 100.
function series(returns: number[]): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < returns.length; i++) {
    price = price * (1 + returns[i]);
    const day = String(i + 1).padStart(2, "0");
    out.push({ date: `2026-01-${day}`, open: price, high: price, low: price, close: price, volume: 1000 } as Candle);
  }
  return out;
}

// n deterministic pseudo-returns (no RNG — pure sine so tests are reproducible).
function wave(n: number, phase = 0, amp = 0.02): number[] {
  return Array.from({ length: n }, (_, i) => amp * Math.sin(i * 0.7 + phase));
}

describe("computeCorrelationClusters", () => {
  it("marks a symbol with no candles as non-computable (avgCorr null, not zero)", () => {
    const candles = new Map<string, Candle[]>([["AAA", []]]);
    const weights = new Map([["AAA", 0.1]]);
    const out = computeCorrelationClusters(candles, weights);
    const a = out.get("AAA")!;
    expect(a.computable).toBe(false);
    expect(a.avgCorr).toBeNull();
  });

  it("two identical return series correlate ~1 and become cluster peers", () => {
    const r = wave(40);
    const candles = new Map<string, Candle[]>([["AAA", series(r)], ["BBB", series(r)]]);
    const weights = new Map([["AAA", 0.1], ["BBB", 0.1]]);
    const out = computeCorrelationClusters(candles, weights, { threshold: 0.6, minOverlap: 30 });
    const a = out.get("AAA")!;
    expect(a.computable).toBe(true);
    expect(a.peers).toContain("BBB");
    expect(a.avgCorr).toBeGreaterThan(0.95);
    expect(a.clusterWeightPct).toBeCloseTo(0.2, 5); // self + peer weight
  });

  it("computable but uncorrelated series report avgCorr 0 (verified low, not missing)", () => {
    // Anti-phase waves → correlation near -1; abs >= threshold so they'd be peers.
    // Use orthogonal-ish paths instead: sine vs cosine-like offset with low corr.
    const candles = new Map<string, Candle[]>([
      ["AAA", series(wave(40, 0))],
      ["BBB", series(wave(40, Math.PI / 2))], // 90° phase → low correlation
    ]);
    const weights = new Map([["AAA", 0.1], ["BBB", 0.1]]);
    const out = computeCorrelationClusters(candles, weights, { threshold: 0.9, minOverlap: 30 });
    const a = out.get("AAA")!;
    expect(a.computable).toBe(true);
    // With a high threshold and low corr, no peer clears it → avgCorr 0, no peers.
    expect(a.peers).toHaveLength(0);
    expect(a.avgCorr).toBe(0);
  });

  it("too little overlap → non-computable", () => {
    const candles = new Map<string, Candle[]>([["AAA", series(wave(10))], ["BBB", series(wave(10))]]);
    const weights = new Map([["AAA", 0.1], ["BBB", 0.1]]);
    const out = computeCorrelationClusters(candles, weights, { minOverlap: 30 });
    expect(out.get("AAA")!.computable).toBe(false);
  });

  it("is pure — identical inputs give identical output", () => {
    const r = wave(40);
    const mk = () => computeCorrelationClusters(
      new Map<string, Candle[]>([["AAA", series(r)], ["BBB", series(r)]]),
      new Map([["AAA", 0.1], ["BBB", 0.1]]),
    );
    expect(Array.from(mk().entries())).toEqual(Array.from(mk().entries()));
  });
});
