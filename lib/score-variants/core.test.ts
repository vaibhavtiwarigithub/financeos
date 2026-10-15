import { describe, expect, it } from "vitest";
import { hacMeanT, VARIANTS, evaluateVariant, fifthMeans, variantScore, type ObsRow } from "@/lib/score-variants/core";

function rng(seed: number) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5); }
const day = (i: number) => new Date(Date.UTC(2026, 9, 1 + i, 14)).toISOString();
const fund = VARIANTS.find((v) => v.id === "fundamental_only")!;
const fs = VARIANTS.find((v) => v.id === "fundamental_sentiment")!;
const exIns = VARIANTS.find((v) => v.id === "composite_ex_insider")!;

/** `sessions` x 30 names. Outcome follows fundamental; the live composite is dominated by an unrelated noisy dimension. */
function world(sessions: number, fundamentalPredicts: boolean): ObsRow[] {
  const r = rng(5);
  const rows: ObsRow[] = [];
  for (let d = 0; d < sessions; d++) for (let s = 0; s < 30; s++) {
    const f = 50 + r() * 60;
    const noise = 50 + r() * 60;
    rows.push({
      ts: day(d), symbol: `S${s}`, y: (fundamentalPredicts ? (f - 50) * 0.002 : 0) + r() * 0.02,
      analyst: 0.3 * f + 0.7 * noise, scores: { fundamental: f, technical: noise, sentiment: 50 + r() * 40 },
      avail: { fundamental: true, technical: true, sentiment: true },
    });
  }
  return rows;
}

describe("score variant forward shadow", () => {
  it("scores a variant as the weighted mean of its dimensions and refuses unavailable or missing inputs", () => {
    const row: ObsRow = { ts: day(0), symbol: "A", y: 0, analyst: 60, scores: { fundamental: 80, technical: 40, sentiment: 60 }, avail: { fundamental: true, technical: true, sentiment: true } };
    expect(variantScore(fund, row)).toBe(80);
    expect(variantScore(fs, row)).toBeCloseTo((0.3 * 80 + 0.2 * 60) / 0.5, 9);
    expect(variantScore(exIns, row)).toBeCloseTo((0.3 * 80 + 0.25 * 40 + 0.2 * 60) / 0.75, 9);
    expect(variantScore(fs, { ...row, avail: { ...row.avail, sentiment: false } })).toBeNull(); // neutral default must not be ranked
    expect(variantScore(fund, { ...row, scores: { technical: 40 } })).toBeNull();
  });
  it("takes the top and bottom fifth deterministically and needs a minimum cross-section", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ symbol: `S${i}`, score: i, y: i }));
    const f = fifthMeans(items)!;
    expect(f.top).toBeCloseTo((16 + 17 + 18 + 19) / 4, 9);
    expect(f.bottom).toBeCloseTo((0 + 1 + 2 + 3) / 4, 9);
    expect(fifthMeans(items.slice(0, 10))).toBeNull();
  });
  it("detects a variant that really predicts and shows it beating a noise-dominated composite on the same rows", () => {
    const ev = evaluateVariant(fund, world(60, true), 5);
    expect(ev.sessions).toBe(60);
    expect(ev.variant.meanIc!).toBeGreaterThan(0.3);
    expect(ev.variant.spread!).toBeGreaterThan(ev.baseline.spread!);
    expect(ev.pairedSpreadDelta!).toBeGreaterThan(0);
    expect(ev.pairedSpreadDeltaT).not.toBeNull();
    expect(ev.variant.topFifthExcess!).toBeGreaterThan(0);
    expect(ev.classification).toBe("measured_descriptive");
    expect(ev.meetsAdoptionGate).toBe(false); // descriptive score metrics are never a promotion gate
    expect(ev.reason).toContain("Newey-West HAC");
  });
  it("does not declare success on pure noise", () => {
    const ev = evaluateVariant(fund, world(60, false), 5);
    expect(Math.abs(ev.variant.meanIc!)).toBeLessThan(0.1);
    expect(ev.meetsAdoptionGate).toBe(false);
    expect(ev.meetsAdoptionGate).toBe(false);
  });
  it("marks a short forward history as insufficient evidence and never passes the adoption gate", () => {
    const ev = evaluateVariant(fund, world(8, true), 10);
    expect(ev.classification).toBe("insufficient_evidence");
    expect(ev.meetsAdoptionGate).toBe(false);
    expect(ev.reason).toContain("need at least");
  });
  it("evaluates the variant and the baseline on exactly the same rows (paired)", () => {
    const rows = world(30, true).map((r, i) => (i % 7 === 0 ? { ...r, avail: { ...r.avail, sentiment: false } } : r));
    const a = evaluateVariant(fs, rows, 5);
    expect(a.avgCrossSection).toBeLessThan(30); // rows without sentiment are dropped for BOTH variant and baseline
    expect(a.avgCrossSection).toBeGreaterThan(20);
  });
  it("freezes the declared set: exactly three variants with the declared weights", () => {
    expect(VARIANTS.map((v) => v.id)).toEqual(["fundamental_only", "fundamental_sentiment", "composite_ex_insider"]);
    expect(exIns.weights).toEqual({ fundamental: 0.30, technical: 0.25, sentiment: 0.20 });
  });
  it("uses HAC uncertainty that is more conservative for positively autocorrelated session statistics", () => {
    const persistent = Array.from({ length: 80 }, (_, i) => 0.01 + (i % 8 < 4 ? 0.004 : -0.004));
    const iidLike = Array.from({ length: 80 }, (_, i) => 0.01 + (i % 2 === 0 ? 0.004 : -0.004));
    expect(hacMeanT(persistent, 9)).toBeLessThan(hacMeanT(iidLike, 9)!);
  });
  it("returns null when the HAC variance is undefined", () => {
    expect(hacMeanT([1, 1, 1], 2)).toBeNull();
    expect(hacMeanT([1], 2)).toBeNull();
  });
  it("is invariant to input row order because sessions are chronologically sorted", () => {
    const rows = world(30, true);
    const a = evaluateVariant(fund, rows, 5);
    const b = evaluateVariant(fund, [...rows].reverse(), 5);
    expect(b.variant.icT).toBeCloseTo(a.variant.icT!, 10);
    expect(b.variant.spreadT).toBeCloseTo(a.variant.spreadT!, 10);
  });
});
