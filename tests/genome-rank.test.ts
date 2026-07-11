import { describe, it, expect } from "vitest";
import { DEFAULT_GENOME, validateGenomeBounds } from "@/lib/validation/genome";

describe("genome — entry.rank_pct_min (cross-sectional-rank plumbing)", () => {
  it("DEFAULT_GENOME ships the rank gate OFF (rank_pct_min = 0.0)", () => {
    expect(DEFAULT_GENOME.entry.rank_pct_min).toBe(0.0);
    // The default genome must still validate.
    expect(validateGenomeBounds(DEFAULT_GENOME).ok).toBe(true);
  });

  it("accepts 0.0 (off) and typical active values, rejects out-of-bounds", () => {
    expect(validateGenomeBounds({ entry: { score_threshold: 60, direction: "long", rank_pct_min: 0.0 } }).ok).toBe(true);
    expect(validateGenomeBounds({ entry: { score_threshold: 60, direction: "long", rank_pct_min: 0.7 } }).ok).toBe(true);
    expect(validateGenomeBounds({ entry: { score_threshold: 60, direction: "long", rank_pct_min: 0.95 } }).ok).toBe(true);
    expect(validateGenomeBounds({ entry: { score_threshold: 60, direction: "long", rank_pct_min: -0.1 } }).ok).toBe(false);
    expect(validateGenomeBounds({ entry: { score_threshold: 60, direction: "long", rank_pct_min: 1.5 } }).ok).toBe(false);
  });

  it("a genome without rank_pct_min still validates (backward compatible)", () => {
    expect(validateGenomeBounds({ entry: { score_threshold: 65, direction: "long" } }).ok).toBe(true);
  });
});
