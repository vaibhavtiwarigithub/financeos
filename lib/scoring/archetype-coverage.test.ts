import { describe, it, expect } from "vitest";
import { ARCHETYPES, routeToArchetypes } from "./archetypes";

// Regression guard for the 2026-07-13..08-24 silent partial outage.
//
// Migration 163 indexed shadow_decisions on (observation_id, policy_version_id)
// NULLS NOT DISTINCT. Every archetype row carries policy_version_id = null, so
// any observation routing to TWO OR MORE experts produced two rows that the
// index considered identical — Postgres rejected the whole batch, and because
// the insert's `.error` was never read, nothing surfaced. Only routes of size 1
// ever landed.
//
// The index is fixed (20260824170000, now keyed on (observation_id,
// setup_type)). These assertions pin the property that made the bug damaging:
// the router legitimately emits multi-expert routes, so any future uniqueness
// rule MUST treat same-observation/different-setup_type rows as distinct.

describe("archetype routing emits multi-expert batches", () => {
  it("routes India to two experts", () => {
    const ids = routeToArchetypes({ isEtf: false, isIndia: true, daysToEarnings: null, fundamentalScore: 60 }).map(a => a.id);
    expect(ids).toEqual(["india_quality_momentum", "india_sector_rotation"]);
    expect(new Set(ids).size).toBe(2);
  });

  it("routes a US equity above the value threshold to two experts", () => {
    const ids = routeToArchetypes({ isEtf: false, isIndia: false, daysToEarnings: null, fundamentalScore: 67 }).map(a => a.id);
    expect(ids).toContain("quality_momentum");
    expect(ids).toContain("value_inflection");
  });

  it("routes a US equity near earnings to three experts", () => {
    const ids = routeToArchetypes({ isEtf: false, isIndia: false, daysToEarnings: 5, fundamentalScore: 67 }).map(a => a.id);
    expect(ids).toHaveLength(3);
  });

  // The one shape that survived the outage, kept so the contrast stays visible.
  it("routes an ETF to exactly one expert", () => {
    expect(routeToArchetypes({ isEtf: true, isIndia: false, daysToEarnings: null, fundamentalScore: 55 })).toHaveLength(1);
  });

  it("never emits the same setup_type twice in one route", () => {
    const cases = [
      { isEtf: false, isIndia: true, daysToEarnings: null, fundamentalScore: 60 },
      { isEtf: false, isIndia: false, daysToEarnings: 5, fundamentalScore: 67 },
      { isEtf: false, isIndia: false, daysToEarnings: null, fundamentalScore: 40 },
      { isEtf: true, isIndia: false, daysToEarnings: null, fundamentalScore: 55 },
    ];
    for (const c of cases) {
      const ids = routeToArchetypes(c).map(a => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("resolves every archetype the router can name", () => {
    // A missing id would make routeToArchetypes return undefined through its
    // non-null assertions, throwing inside the caller's .map and silently
    // dropping that symbol's entire shadow batch.
    const cases = [
      { isEtf: false, isIndia: true, daysToEarnings: null, fundamentalScore: 60 },
      { isEtf: false, isIndia: false, daysToEarnings: 5, fundamentalScore: 67 },
      { isEtf: true, isIndia: false, daysToEarnings: null, fundamentalScore: 55 },
    ];
    for (const c of cases) {
      for (const a of routeToArchetypes(c)) {
        expect(a).toBeDefined();
        expect(ARCHETYPES.some(x => x.id === a.id)).toBe(true);
      }
    }
  });
});
