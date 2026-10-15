import { describe, expect, it } from "vitest";
import type { ObsRow } from "@/lib/score-variants/core";
import { asMinedVariant, mineFormulaCandidates, miningRationale, parseMiningRationale, simplexWeightGrid } from "@/lib/score-variants/mining";

function world(sessions = 30): ObsRow[] {
  const rows: ObsRow[] = [];
  for (let d = 0; d < sessions; d++) {
    for (let i = 0; i < 30; i++) {
      const f = (i * 37 + d * 3) % 101;
      const t = (i * 17 + d * 13) % 101;
      const y = (f - 50) / 5000 + ((i * 19 + d * 7) % 11 - 5) / 1000;
      rows.push({
        ts: new Date(Date.UTC(2026, 0, 1 + d, 15)).toISOString(), symbol: `S${String(i).padStart(2, "0")}`,
        y, analyst: (f + t) / 2, scores: { fundamental: f, technical: t, sentiment: 100 - t, insider: 50 },
        avail: { fundamental: true, technical: true, sentiment: true, insider: false },
      });
    }
  }
  return rows;
}

describe("historical score formula mining", () => {
  it("enumerates the fixed 0.1 simplex without negative or unnormalized weights", () => {
    const grid = simplexWeightGrid(["fundamental", "technical", "sentiment", "insider"]);
    expect(grid).toHaveLength(286);
    expect(grid.every((w) => Object.values(w).every((v) => (v ?? -1) >= 0) && Math.abs(Object.values(w).reduce((a, b) => a + (b ?? 0), 0) - 1) < 1e-9)).toBe(true);
  });

  it("mines one intentionally in-sample winner and factor-removal candidates deterministically", () => {
    const rows = world();
    const first = mineFormulaCandidates(rows, 5);
    const again = mineFormulaCandidates(rows, 5);
    expect(first.trialsConsidered).toBe(66); // 3 dimensions available; insider is unavailable in this fixture.
    expect(first.candidates[0].role).toBe("full_sample_fit");
    expect(first.candidates[0].weights).toEqual(again.candidates[0].weights);
    expect(first.candidates.some((c) => c.role === "without_fundamental")).toBe(true);
    expect(first.candidates.every((c) => c.weights.insider == null)).toBe(true); // unavailable must never enter a formula
    expect(first.candidates[0].reason).toContain("not evidence");
    expect(first.candidates.every((candidate) => candidate.coverageRows === first.rows)).toBe(true);
  });

  it("uses one complete-case cohort for every candidate instead of rewarding missingness", () => {
    const rows = world().map((row, index) => index % 31 === 0
      ? { ...row, scores: { ...row.scores, sentiment: null } }
      : row);
    const result = mineFormulaCandidates(rows, 5);
    expect(result.rows).toBe(rows.length - Math.ceil(rows.length / 31));
    expect(new Set(result.candidates.map((candidate) => candidate.coverageRows)).size).toBe(1);
    expect(result.candidates.every((candidate) => candidate.meanIcT != null && candidate.spreadT != null)).toBe(true);
  });

  it("does not let duplicate symbol/session labels inflate the candidate sample", () => {
    const rows = world(25);
    const original = mineFormulaCandidates(rows, 5);
    const duplicated = mineFormulaCandidates([...rows, ...rows], 5);
    expect(duplicated.rows).toBe(original.rows);
    expect(duplicated.qualifyingSessions).toBe(original.qualifyingSessions);
    expect(duplicated.candidates[0].weights).toEqual(original.candidates[0].weights);
  });

  it("records immutable lineage metadata and refuses malformed formula weights", () => {
    const candidate = mineFormulaCandidates(world(25), 5).candidates[0];
    const rationale = miningRationale({ runFingerprint: "abc", datasetFingerprint: "def", market: "us", horizonDays: 5, fitCutoff: "2026-01-25", dimensionsAvailable: ["fundamental", "technical"], trialCount: 11, totalRunTrials: 88, candidate });
    expect(parseMiningRationale(rationale)?.caveat).toContain("INTENTIONALLY SELECTED");
    expect(asMinedVariant({ variant_id: "x", label: "x", weights: candidate.weights, rationale })).not.toBeNull();
    expect(asMinedVariant({ variant_id: "x", label: "x", weights: { fundamental: 0.4, technical: 0.4 }, rationale })).toBeNull();
    expect(parseMiningRationale("not-json")).toBeNull();
  });
});
