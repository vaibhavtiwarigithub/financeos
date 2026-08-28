import { describe, it, expect } from "vitest";
import {
  resolveExitPath, runA4ExitPaths, runA5Sizing, runA7CostStress, runA8Robustness,
  notionalReturnRankCorrelation, netOfCost, seededShuffle, placeboPValue, adjustedAlpha,
  datedRankIc, permuteOutcomesWithinDate,
  type ExitPathLot, type SizedLot,
} from "./alpha-diagnostics-counterfactual";
import type { ClosedLot } from "./alpha-diagnostics";

describe("A4 resolveExitPath", () => {
  const base = { targetPct: 8, stopPct: 7 };

  it("resolves a clean target touch", () => {
    expect(resolveExitPath({ ...base, mfe: 0.10, mae: -0.01 })).toBe("target_first");
  });

  it("resolves a clean stop breach", () => {
    expect(resolveExitPath({ ...base, mfe: 0.01, mae: -0.09 })).toBe("stop_first");
  });

  // THE load-bearing case. Both barriers touched inside the window; daily MFE/MAE
  // cannot order them. Resolving this favourably would manufacture a winner.
  it("refuses to order two barriers touched in the same window", () => {
    expect(resolveExitPath({ ...base, mfe: 0.10, mae: -0.09 })).toBe("ambiguous");
  });

  it("reports neither when the lot stayed inside both barriers", () => {
    expect(resolveExitPath({ ...base, mfe: 0.02, mae: -0.02 })).toBe("neither_touched");
  });

  it("treats a missing excursion as unavailable rather than as untouched", () => {
    expect(resolveExitPath({ ...base, mfe: null, mae: null })).toBe("unavailable");
    expect(resolveExitPath({ ...base, mfe: null, mae: -0.09 })).toBe("unavailable");
  });

  it("uses the magnitude of the stop regardless of sign convention", () => {
    expect(resolveExitPath({ mfe: 0.01, mae: -0.09, targetPct: 8, stopPct: -7 })).toBe("stop_first");
  });
});

describe("A4 runA4ExitPaths", () => {
  const lot = (over: Partial<ExitPathLot> = {}): ExitPathLot => ({
    symbol: "AAA", market: "us", realizedPnl: 1, pnlPct: 1,
    mfe: 0.02, mae: -0.02, exitReason: "time_stop", entryDate: "2026-08-01", exitDate: "2026-08-12", targetPct: 8, stopPct: 7, ...over,
  });

  it("counts ambiguous lots and excludes them from resolvable coverage", () => {
    const f = runA4ExitPaths("us", [
      lot({ mfe: 0.10, mae: -0.09 }),   // ambiguous
      lot({ mfe: 0.10, mae: -0.01 }),   // target
    ]);
    expect((f.metrics.resolutions as any).ambiguous).toBe(1);
    expect(f.coverage).toBeCloseTo(0.5, 6);
    expect(f.reason).toContain("touched both barriers");
  });
});

describe("A5 sizing", () => {
  const lot = (notional: number, pnlPct: number): SizedLot => ({
    symbol: `S${notional}`, entryNotional: notional, pnlPct,
    realizedPnl: notional * (pnlPct / 100), entryDate: "2026-08-01", exitDate: "2026-08-12",
  });

  it("detects that the biggest positions were the losers", () => {
    // Small winners, large losers: flat sizing should beat actual.
    const lots = [lot(100, 10), lot(100, 10), lot(1000, -5), lot(1000, -5)];
    const f = runA5Sizing("us", lots);
    expect(f.metrics.sizingCostCurrency as number).toBeGreaterThan(0);
    expect(notionalReturnRankCorrelation(lots)!).toBeLessThan(0);
  });

  it("reports no sizing cost when allocation is already flat", () => {
    const lots = [lot(500, 4), lot(500, -2), lot(500, 6)];
    expect(runA5Sizing("us", lots).metrics.sizingCostCurrency as number).toBeCloseTo(0, 6);
  });

  it("returns null correlation rather than a number from too few lots", () => {
    expect(notionalReturnRankCorrelation([lot(1, 1), lot(2, 2)])).toBeNull();
  });

  it("refuses an empty cohort", () => {
    expect(runA5Sizing("us", []).status).toBe("insufficient_evidence");
  });

  it("excludes missing outcomes instead of treating them as zero return", () => {
    const missing = { ...lot(100, 5), pnlPct: Number.NaN, realizedPnl: Number.NaN };
    const f = runA5Sizing("us", [lot(200, 10), missing]);
    expect(f.sample.nRows).toBe(1);
    expect(f.coverage).toBe(0.5);
    expect(f.metrics.actualCurrencyPnl).toBe(20);
  });
});

describe("A7 cost stress", () => {
  const lot = (pnlPct: number): ClosedLot => ({
    symbol: "AAA", market: "us", realizedPnl: pnlPct, pnlPct, mfe: null, mae: null, exitReason: null, entryDate: "2026-08-01", exitDate: "2026-08-12",
  });

  it("is monotonically worse as cost rises", () => {
    const f = runA7CostStress("us", [lot(1), lot(2), lot(3)]);
    const means = (f.metrics.levels as any[]).map(l => l.meanNetReturnPct as number);
    for (let i = 1; i < means.length; i++) expect(means[i]).toBeLessThan(means[i - 1]);
  });

  it("shows an edge dying under realistic cost", () => {
    // +0.2% gross per lot cannot survive a 25bps round trip.
    const f = runA7CostStress("us", [lot(0.2), lot(0.2), lot(0.2)]);
    const l25 = (f.metrics.levels as any[]).find(l => l.roundTripBps === 25);
    expect(l25.meanNetReturnPct as number).toBeLessThan(0);
    expect(l25.profitableLots).toBe(0);
  });

  // "80% of a negative edge survived" would read as a pass. It must be null.
  it("does not report a surviving fraction when the gross edge is negative", () => {
    const f = runA7CostStress("us", [lot(-1), lot(-2)]);
    for (const l of f.metrics.levels as any[]) expect(l.survivingFraction).toBeNull();
  });

  it("netOfCost converts basis points correctly", () => {
    expect(netOfCost(1.0, 25)).toBeCloseTo(0.75, 10);
  });
});

describe("A8 robustness", () => {
  const rankedRows = (nDates: number) => Array.from({ length: nDates }, (_, d) =>
    Array.from({ length: 5 }, (_, score) => ({
      date: `d${String(d).padStart(3, "0")}`,
      symbol: `S${score}`,
      score,
      forwardReturn: score * 0.01 + d * 0.000001,
    }))).flat();
  const meanDiff = (s: number[], o: number[]) => {
    // Simple statistic: mean outcome of the top half by score minus the bottom.
    const paired = s.map((v, i) => ({ v, o: o[i] })).sort((a, b) => a.v - b.v);
    const half = Math.floor(paired.length / 2);
    if (half === 0) return null;
    const bot = paired.slice(0, half).reduce((a, p) => a + p.o, 0) / half;
    const top = paired.slice(-half).reduce((a, p) => a + p.o, 0) / half;
    return top - bot;
  };

  it("seededShuffle is deterministic and does not mutate the input", () => {
    const src = [1, 2, 3, 4, 5];
    const a = seededShuffle(src, 7);
    const b = seededShuffle(src, 7);
    expect(a).toEqual(b);
    expect(src).toEqual([1, 2, 3, 4, 5]);
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("gives a real signal a low placebo p-value", () => {
    const scores = Array.from({ length: 40 }, (_, i) => i);
    const outcomes = scores.map(s => s * 0.01);
    const real = meanDiff(scores, outcomes)!;
    expect(placeboPValue(real, scores, outcomes, meanDiff).pValue).toBeLessThan(0.05);
  });

  // (b+1)/(m+1), not b/m. A p-value of exactly 0 clears every alpha including a
  // heavily trial-adjusted one, claiming more precision than m permutations can
  // resolve -- that is how a multiple-testing correction gets defeated by a
  // number the experiment never measured.
  it("never reports p=0, and floors at 1/(iterations+1)", () => {
    const scores = Array.from({ length: 40 }, (_, i) => i);
    const outcomes = scores.map(s => s * 0.01);
    const real = meanDiff(scores, outcomes)!;
    const r = placeboPValue(real, scores, outcomes, meanDiff);
    expect(r.pValue).toBeGreaterThan(0);
    expect(r.pValue).toBeCloseTo(1 / (r.iterations + 1), 10);
  });

  it("gives pure noise a high placebo p-value", () => {
    const scores = Array.from({ length: 40 }, (_, i) => i);
    // Outcome unrelated to score: the real statistic is one draw from the
    // placebo distribution, so it should not look extreme.
    const outcomes = seededShuffle(scores.map(s => s * 0.01), 99);
    const real = meanDiff(scores, outcomes)!;
    expect(placeboPValue(real, scores, outcomes, meanDiff).pValue).toBeGreaterThan(0.05);
  });

  it("returns p=1 rather than 0 when no placebo draw was usable", () => {
    // Conservative: no evidence of robustness must never read as a pass.
    expect(placeboPValue(1, [1, 2], [1, 2], () => null).pValue).toBe(1);
    expect(placeboPValue(1, [1, 2, 3], [1, 2, 3], () => null).pValue).toBe(1);
  });

  it("adjustedAlpha tightens as trials grow and never exceeds base", () => {
    expect(adjustedAlpha(0.05, 1)).toBeCloseTo(0.05, 10);
    expect(adjustedAlpha(0.05, 20)).toBeLessThan(0.05);
    expect(adjustedAlpha(0.05, 20)).toBeGreaterThan(0);
    expect(adjustedAlpha(0.05, 0)).toBeCloseTo(0.05, 10); // guarded against 0/negative
  });

  it("permutes outcomes only within their original date", () => {
    const rows = [
      { date: "d1", symbol: "A", score: 1, forwardReturn: 1 },
      { date: "d1", symbol: "B", score: 2, forwardReturn: 2 },
      { date: "d2", symbol: "A", score: 1, forwardReturn: 100 },
      { date: "d2", symbol: "B", score: 2, forwardReturn: 200 },
    ];
    const p = permuteOutcomesWithinDate(rows, 7);
    expect(p.filter(r => r.date === "d1").map(r => r.forwardReturn).sort()).toEqual([1, 2]);
    expect(p.filter(r => r.date === "d2").map(r => r.forwardReturn).sort()).toEqual([100, 200]);
  });

  it("fails a real-looking edge once enough trials are declared", () => {
    const rows = rankedRows(30);
    const one = runA8Robustness("us", {
      rows, trialsConsidered: 1, minDates: 20, horizonDays: 1, iterations: 200,
    });
    const many = runA8Robustness("us", {
      rows, trialsConsidered: 500, minDates: 20, horizonDays: 1, iterations: 200,
    });
    expect(one.metrics.realStatistic).toBeCloseTo(datedRankIc(rows)!, 12);
    expect(one.status).toBe("pass");
    // Same data, same statistic — only the declared trial count changed.
    expect(many.status).toBe("fail");
  });

  it("cannot pass below the date floor no matter how strong the statistic", () => {
    const f = runA8Robustness("us", {
      rows: rankedRows(5), trialsConsidered: 1, minDates: 60, horizonDays: 1, iterations: 20,
    });
    expect(f.status).toBe("insufficient_evidence");
  });

  it("applies the overlapping-horizon floor to h10", () => {
    const f = runA8Robustness("us", {
      rows: rankedRows(60), trialsConsidered: 1, minDates: 60, horizonDays: 10, iterations: 20,
    });
    expect(f.status).toBe("insufficient_evidence");
    expect(f.reason).toContain("independent observations");
  });
});
