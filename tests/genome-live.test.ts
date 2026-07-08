import { describe, it, expect } from "vitest";
import { DEFAULT_GENOME } from "@/lib/validation/genome";
import { loadChampionGenome } from "@/lib/validation/genome-live";

// Build 1: the champion genome is a LIVE control. These tests lock the two
// invariants the wiring depends on: (1) DEFAULT_GENOME must equal the values the
// live path hardcoded before this build, so a genome-less market is unchanged;
// (2) loadChampionGenome must degrade to the default genome — never throw — on a
// missing champion, a null genome, or an out-of-bounds stored genome.

// Minimal supabase stub: a chainable query builder that resolves to a fixed row.
function stub(row: any, error: any = null) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: row, error }),
  };
  return { from: () => builder };
}

describe("DEFAULT_GENOME preserves pre-Build-1 live behavior", () => {
  it("matches the values the decision path hardcoded before genome wiring", () => {
    // research-agent.ts final threshold fallback was 60
    expect(DEFAULT_GENOME.entry.score_threshold).toBe(60);
    // paper-trade getGlobalMaeMfePercentiles was called with 10, 0.25, 0.75
    expect(DEFAULT_GENOME.horizon_days).toBe(10);
    expect(DEFAULT_GENOME.exit.stop_mae_pctile).toBe(25);
    expect(DEFAULT_GENOME.exit.target_mfe_pctile).toBe(75);
    // Kelly floor was Math.min(2, size); default floor is 2
    expect(DEFAULT_GENOME.sizing.floor_pct).toBe(2);
    expect(DEFAULT_GENOME.sizing.mode).toBe("half_kelly");
  });
});

describe("loadChampionGenome degrades safely to default", () => {
  it("returns default when no champion row exists", async () => {
    const r = await loadChampionGenome(stub(null), "us");
    expect(r.source).toBe("default");
    expect(r.genome).toEqual(DEFAULT_GENOME);
  });

  it("returns default when the champion has a null genome", async () => {
    const r = await loadChampionGenome(stub({ genome: null }), "us");
    expect(r.source).toBe("default");
  });

  it("hydrates a partial champion genome onto the default", async () => {
    const r = await loadChampionGenome(stub({ genome: { entry: { score_threshold: 70, direction: "long" } } }), "us");
    expect(r.source).toBe("champion");
    expect(r.genome.entry.score_threshold).toBe(70);
    // untouched groups fall back to the default
    expect(r.genome.exit.stop_mae_pctile).toBe(DEFAULT_GENOME.exit.stop_mae_pctile);
    expect(r.genome.sizing.cap_pct).toBe(DEFAULT_GENOME.sizing.cap_pct);
  });

  it("rejects an out-of-bounds stored genome back to default", async () => {
    // score_threshold bound is [50,75]; 999 must not size a live fill
    const r = await loadChampionGenome(stub({ genome: { entry: { score_threshold: 999, direction: "long" } } }), "us");
    expect(r.source).toBe("default");
  });

  it("returns default (never throws) when the query errors", async () => {
    const throwing = { from: () => ({ select: () => { throw new Error("db down"); } }) };
    const r = await loadChampionGenome(throwing, "india");
    expect(r.source).toBe("default");
  });
});
