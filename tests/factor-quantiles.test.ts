import { describe, expect, it } from "vitest";
import {
  quantileDiagnostics, assignBuckets, MIN_PER_BUCKET, MIN_AUTOCORR_OVERLAP,
  type FactorRow,
} from "@/lib/learning/factor-quantiles";

// Method ported from alphalens (mean_return_by_quantile,
// compute_mean_returns_spread, factor_rank_autocorrelation).
//
// WHY IT EXISTS. Rank IC says the ordering correlates with returns. It cannot
// say whether the ordering is MONOTONIC — and a small positive IC is equally
// consistent with a clean gradient (tradeable) and a flat middle with one
// extreme tail dragging the correlation (an artifact). Production 2026-09-02:
// sentiment +0.0886 and technical -0.1325 are indistinguishable between those.

/** Build `sessions` days of a cross-section with a chosen value->outcome shape. */
function build(
  sessions: number,
  perSession: number,
  outcomeFor: (rank: number, perSession: number) => number,
  valueFor: (rank: number) => number = (r) => r,
): FactorRow[] {
  const rows: FactorRow[] = [];
  for (let d = 0; d < sessions; d++) {
    const ts = `2026-03-${String(d + 1).padStart(2, "0")}T13:00:00Z`;
    for (let i = 0; i < perSession; i++) {
      rows.push({ symbol: `S${i}`, value: valueFor(i), outcome: outcomeFor(i, perSession), ts });
    }
  }
  return rows;
}

describe("quantile returns separate a real gradient from a tail artifact", () => {
  it("reports a monotonic gradient as monotonicity ~ +1", () => {
    const rows = build(10, 25, (rank) => rank * 0.001);
    const result = quantileDiagnostics(rows, { nEffective: 10 });
    expect(result.qualifying_sessions).toBe(10);
    expect(result.monotonicity).toBeCloseTo(1, 5);
    expect(result.spread_top_minus_bottom!).toBeGreaterThan(0);
  });

  it("distinguishes a TAIL ARTIFACT from a gradient, which IC alone cannot", () => {
    // Flat middle, one extreme top bucket. A rank IC is positive here, but the
    // signal is not a gradient: buckets 1..4 are indistinguishable. This is the
    // case the whole feature exists to expose.
    const rows = build(10, 25, (rank, n) => (rank >= n - 5 ? 0.05 : 0.0));
    const result = quantileDiagnostics(rows, { nEffective: 10 });
    const buckets = result.mean_return_by_quantile;
    expect(buckets[0]).toBeCloseTo(0, 10);
    expect(buckets[3]).toBeCloseTo(0, 10);   // still flat at the 4th bucket
    expect(buckets[4]!).toBeGreaterThan(0.04); // all of the return is in the top
    // Spread is positive, but the gradient is absent below the top bucket.
    expect(result.spread_top_minus_bottom!).toBeGreaterThan(0);
  });

  it("reports an inverted factor as negative monotonicity and a negative spread", () => {
    const rows = build(10, 25, (rank, n) => (n - rank) * 0.001);
    const result = quantileDiagnostics(rows, { nEffective: 10 });
    expect(result.monotonicity).toBeCloseTo(-1, 5);
    expect(result.spread_top_minus_bottom!).toBeLessThan(0);
  });
});

describe("spread significance uses nEffective, not the session count", () => {
  it("divides the standard error by sqrt(nEffective)", () => {
    // Overlapping forward windows are not independent draws. Using sqrt(sessions)
    // would overstate |t| by sqrt(horizon) — the same error the IC path corrects.
    // Spreads must VARY across sessions or the sd is ~0 and both sides correctly
    // return null — an earlier version of this test used a constant gradient and
    // compared null against null, proving nothing.
    const rows: FactorRow[] = [];
    for (let d = 0; d < 20; d++) {
      const ts = `2026-03-${String(d + 1).padStart(2, "0")}T13:00:00Z`;
      const strength = 0.001 * (1 + (d % 5));  // gradient steepness moves by day
      for (let i = 0; i < 25; i++) {
        rows.push({ symbol: `S${i}`, value: i, outcome: i * strength, ts });
      }
    }
    const withOverlap = quantileDiagnostics(rows, { nEffective: 4 });
    const asIfIndependent = quantileDiagnostics(rows, { nEffective: 20 });
    expect(withOverlap.spread_t).not.toBeNull();
    expect(withOverlap.spread_std_error!).toBeGreaterThan(asIfIndependent.spread_std_error!);
    expect(Math.abs(withOverlap.spread_t!)).toBeLessThan(Math.abs(asIfIndependent.spread_t!));
  });

  it("returns null rather than Infinity when the spread never varies", () => {
    // Identical spread every session -> sd 0. Infinity would render as decisive.
    const rows = build(10, 25, (rank) => rank * 0.001);
    const result = quantileDiagnostics(rows, { nEffective: 10 });
    // sd is floating-point dust (1.16e-18 measured), not exactly 0 — a `> 0`
    // guard would pass it and produce a t of ~1e15.
    expect(result.spread_std_error!).toBeLessThan(1e-12);
    expect(result.spread_t).toBeNull();
  });
});

describe("degenerate cross-sections are excluded, not bucketed", () => {
  it("excludes a CONSTANT dimension — the macro case", () => {
    // macro is one market-wide scalar per day. It has no cross-section to split,
    // which is the same fact that makes its IC exactly 0.0000 by construction.
    // Bucketing it would invent five identical quintiles and report a 0 spread
    // as if it had been measured.
    const rows = build(10, 25, (rank) => rank * 0.001, () => 69);
    const result = quantileDiagnostics(rows, { nEffective: 10 });
    expect(result.qualifying_sessions).toBe(0);
    expect(result.excluded_sessions).toBe(10);
    expect(result.spread_top_minus_bottom).toBeNull();
    expect(result.rank_autocorrelation).toBeNull();
  });

  it("excludes a session too thin to fill every bucket", () => {
    const thin = 5 * MIN_PER_BUCKET - 1;
    const result = quantileDiagnostics(build(6, thin, (r) => r * 0.001), { nEffective: 6 });
    expect(result.qualifying_sessions).toBe(0);
    expect(result.excluded_sessions).toBe(6);
  });

  it("counts exclusions rather than silently folding them in", () => {
    const good = build(4, 25, (r) => r * 0.001);
    const bad = build(3, 25, (r) => r * 0.001, () => 42).map((row) => ({
      ...row, ts: row.ts.replace("2026-03-0", "2026-04-0"),
    }));
    const result = quantileDiagnostics([...good, ...bad], { nEffective: 4 });
    expect(result.qualifying_sessions).toBe(4);
    expect(result.excluded_sessions).toBe(3);
  });
});

describe("rank autocorrelation separates 'inverted' from 'noise'", () => {
  it("reports ~+1 when the ranking is stable across sessions", () => {
    // Stable but inverted is ACTIONABLE (flip or drop it). Noise is a data
    // problem. An IC table shows both as simply negative.
    const rows = build(8, 25, (rank, n) => (n - rank) * 0.001);
    const result = quantileDiagnostics(rows, { nEffective: 8 });
    expect(result.rank_autocorrelation).toBeCloseTo(1, 5);
    expect(result.autocorrelation_pairs).toBe(7);
  });

  it("reports near zero when the ranking is reshuffled each session", () => {
    const rows: FactorRow[] = [];
    for (let d = 0; d < 8; d++) {
      const ts = `2026-03-0${d + 1}T13:00:00Z`;
      for (let i = 0; i < 25; i++) {
        // Deterministic permutation that decorrelates consecutive sessions.
        rows.push({ symbol: `S${i}`, value: (i * 7 + d * 11) % 25, outcome: 0.001 * i, ts });
      }
    }
    const result = quantileDiagnostics(rows, { nEffective: 8 });
    expect(Math.abs(result.rank_autocorrelation!)).toBeLessThan(0.5);
  });

  it("skips consecutive sessions that share too few symbols to compare", () => {
    const rows: FactorRow[] = [];
    for (let d = 0; d < 4; d++) {
      const ts = `2026-03-0${d + 1}T13:00:00Z`;
      for (let i = 0; i < 25; i++) {
        // Disjoint universes each day -> nothing to correlate.
        rows.push({ symbol: `D${d}_S${i}`, value: i, outcome: 0.001 * i, ts });
      }
    }
    const result = quantileDiagnostics(rows, { nEffective: 4 });
    expect(result.autocorrelation_pairs).toBe(0);
    expect(result.rank_autocorrelation).toBeNull();
    expect(MIN_AUTOCORR_OVERLAP).toBe(5);
  });
});

describe("assignBuckets", () => {
  it("splits into equal-sized buckets, lowest value first", () => {
    const rows = [5, 1, 4, 2, 3].map((v) => ({ v }));
    const split = assignBuckets(rows, (r) => r.v, 5);
    expect(split.map((b) => b.map((r) => r.v))).toEqual([[1], [2], [3], [4], [5]]);
  });

  it("puts the remainder in the top bucket rather than dropping rows", () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((v) => ({ v }));
    const split = assignBuckets(rows, (r) => r.v, 5);
    expect(split.flat()).toHaveLength(7);
    expect(split[4].map((r) => r.v)).toContain(7);
  });
});
