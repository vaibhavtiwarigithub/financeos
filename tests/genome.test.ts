import { describe, it, expect } from "vitest";
import { validateGenomeBounds, genomeDiffCount, genomeHash, DEFAULT_GENOME } from "@/lib/validation/genome";

describe("validateGenomeBounds", () => {
  it("accepts the default genome unchanged", () => {
    expect(validateGenomeBounds(DEFAULT_GENOME).ok).toBe(true);
  });

  it("rejects an entry.score_threshold outside [50,75]", () => {
    expect(validateGenomeBounds({ entry: { score_threshold: 30, direction: "long" } }).ok).toBe(false);
    expect(validateGenomeBounds({ entry: { score_threshold: 90, direction: "long" } }).ok).toBe(false);
    expect(validateGenomeBounds({ entry: { score_threshold: 65, direction: "long" } }).ok).toBe(true);
  });

  it("rejects a horizon_days not in {2,5,10,20}", () => {
    expect(validateGenomeBounds({ horizon_days: 7 as any }).ok).toBe(false);
    expect(validateGenomeBounds({ horizon_days: 5 }).ok).toBe(true);
  });

  it("rejects sizing.cap_pct outside [5,15]", () => {
    expect(validateGenomeBounds({ sizing: { mode: "half_kelly", cap_pct: 50, floor_pct: 2 } }).ok).toBe(false);
    expect(validateGenomeBounds({ sizing: { mode: "half_kelly", cap_pct: 12, floor_pct: 2 } }).ok).toBe(true);
  });
});

describe("genomeDiffCount", () => {
  it("counts zero diffs for an identical genome", () => {
    expect(genomeDiffCount(DEFAULT_GENOME, DEFAULT_GENOME)).toBe(0);
  });

  it("counts exactly one diff when only one leaf field changes", () => {
    const proposed = { ...DEFAULT_GENOME, entry: { ...DEFAULT_GENOME.entry, score_threshold: 65 } };
    expect(genomeDiffCount(DEFAULT_GENOME, proposed)).toBe(1);
  });

  it("counts two diffs when two leaf fields change", () => {
    const proposed = {
      ...DEFAULT_GENOME,
      entry: { ...DEFAULT_GENOME.entry, score_threshold: 65 },
      horizon_days: 5 as const,
    };
    expect(genomeDiffCount(DEFAULT_GENOME, proposed)).toBe(2);
  });
});

describe("genomeHash", () => {
  it("is deterministic for the same genome", () => {
    expect(genomeHash(DEFAULT_GENOME)).toBe(genomeHash(DEFAULT_GENOME));
  });

  it("differs when the genome changes", () => {
    const proposed = { ...DEFAULT_GENOME, horizon_days: 5 as const };
    expect(genomeHash(DEFAULT_GENOME)).not.toBe(genomeHash(proposed));
  });
});
