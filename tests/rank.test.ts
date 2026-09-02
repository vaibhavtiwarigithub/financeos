import { describe, it, expect } from "vitest";
import {
  computeComparableRank,
  isRankRejected,
  type RankCandidate,
  type RankResult,
  RANK_MIN_GROUP_EQUITY_US,
  RANK_MIN_GROUP_EQUITY_INDIA,
  RANK_FLOOR_LO,
  RANK_FLOOR_HI,
} from "@/lib/scoring/rank";

// Helper: a plain eligible US-equity long candidate.
// GROUP KEYS ARE CANONICAL GICS SECTORS (2026-09-02). normalizeSector used to
// lowercase the raw provider label, so `Semiconductors` and `Technology` were
// different groups; with a median of ~2 symbols per raw label essentially every
// sector group fell under RANK_MIN_GROUP_EQUITY_US and collapsed into the
// market-wide fallback. Raw labels now resolve through
// lib/scoring/sector-taxonomy.ts, so a group key reads "us:equity:Information
// Technology". Only the NAME changed here — grouping, percentile and quality
// behaviour are unchanged.
function usEquity(symbol: string, score: number, sector: string | null = "technology"): RankCandidate {
  return {
    symbol,
    analystScore: score,
    market: "us",
    assetType: "equity",
    sector,
    evidenceConfidence: 0.9,
    direction: "long",
    isHeld: false,
  };
}

function bySymbol(results: RankResult[]): Map<string, RankResult> {
  return new Map(results.map(r => [r.symbol, r]));
}

describe("computeComparableRank — grouped percentile correctness", () => {
  it("computes an empirical percentile over a large-enough single-sector group", () => {
    // 25 tech names (>= RANK_MIN_GROUP_EQUITY_US=20) with distinct scores 50..74.
    const cands = Array.from({ length: 25 }, (_, i) => usEquity(`T${i}`, 50 + i));
    const res = bySymbol(computeComparableRank(cands));

    // Lowest scorer → 0, highest → 1, all 'ok', group_n = 25.
    expect(res.get("T0")!.rank_pct).toBe(0);
    expect(res.get("T0")!.rank_quality).toBe("ok");
    expect(res.get("T0")!.comparable_group_key).toBe("us:equity:Information Technology");
    expect(res.get("T0")!.group_n).toBe(25);
    expect(res.get("T24")!.rank_pct).toBe(1);
    // A middle name: 12 of 24 peers score strictly below T12 → 12/24 = 0.5.
    expect(res.get("T12")!.rank_pct).toBeCloseTo(12 / 24, 10);
    for (const r of res.values()) expect(r.rank_eligible).toBe(true);
  });

  it("ranking is deterministic and independent of input ordering", () => {
    const cands = Array.from({ length: 22 }, (_, i) => usEquity(`T${i}`, 50 + i));
    const a = bySymbol(computeComparableRank(cands));
    const b = bySymbol(computeComparableRank([...cands].reverse()));
    for (const s of cands.map(c => c.symbol)) {
      expect(a.get(s)!.rank_pct).toBe(b.get(s)!.rank_pct);
      expect(a.get(s)!.rank_quality).toBe(b.get(s)!.rank_quality);
    }
  });

  it("ties share a rank (percentile is a monotonic transform of analyst_score)", () => {
    const cands = Array.from({ length: 21 }, (_, i) => usEquity(`T${i}`, 60)); // all equal
    const res = computeComparableRank(cands);
    // No peer scores strictly below → every rank_pct = 0, all 'ok'.
    for (const r of res) {
      expect(r.rank_pct).toBe(0);
      expect(r.rank_quality).toBe("ok");
    }
  });
});

describe("computeComparableRank — within-group ordering equals analyst_score ordering", () => {
  it("ordering by rank_pct matches ordering by analyst_score inside a group", () => {
    const scores = [51, 73, 62, 58, 69, 55, 66, 60, 71, 52, 64, 57, 68, 59, 70, 53, 65, 61, 72, 54, 67];
    const cands = scores.map((s, i) => usEquity(`T${i}`, s));
    const res = computeComparableRank(cands);
    const bySym = bySymbol(res);
    const sortedByScore = [...cands].sort((a, b) => a.analystScore - b.analystScore).map(c => c.symbol);
    const sortedByRank = [...cands]
      .sort((a, b) => (bySym.get(a.symbol)!.rank_pct! - bySym.get(b.symbol)!.rank_pct!))
      .map(c => c.symbol);
    // Compare by the underlying score sequence to be robust to tie orderings.
    expect(sortedByRank.map(s => bySym.get(s)!.rank_pct)).toEqual(
      sortedByScore.map(s => bySym.get(s)!.rank_pct)
    );
  });
});

describe("computeComparableRank — ETFs never mix with equities", () => {
  it("puts ETFs in a separate group from single-name equities", () => {
    const cands: RankCandidate[] = [
      ...Array.from({ length: 20 }, (_, i) => usEquity(`T${i}`, 55 + i)),
      { symbol: "GLD", analystScore: 60, market: "us", assetType: "etf", sector: null, evidenceConfidence: 0.9, direction: "long", isHeld: false },
      { symbol: "SLV", analystScore: 58, market: "us", assetType: "etf", sector: null, evidenceConfidence: 0.9, direction: "long", isHeld: false },
    ];
    const res = bySymbol(computeComparableRank(cands));
    expect(res.get("GLD")!.comparable_group_key).toBe("us:etf:all");
    expect(res.get("SLV")!.comparable_group_key).toBe("us:etf:all");
    // The 2-name ETF group is below its min sample → degraded, not a fabricated percentile.
    expect(res.get("GLD")!.rank_quality).toBe("degraded");
    // Equities remain their own 'ok' group.
    expect(res.get("T0")!.comparable_group_key).toBe("us:equity:Information Technology");
    expect(res.get("T0")!.rank_quality).toBe("ok");
  });
});

describe("computeComparableRank — small-group degraded path ('three finalists are not a universe')", () => {
  it("uses the pre-registered fixed transform for a sub-min group and flags degraded", () => {
    const cands = [usEquity("A", 45), usEquity("B", 62.5), usEquity("C", 80)];
    const res = bySymbol(computeComparableRank(cands));
    // Falls back to us:equity:all (sector group has < 20 names), degraded transform.
    for (const s of ["A", "B", "C"]) {
      expect(res.get(s)!.rank_quality).toBe("degraded");
      expect(res.get(s)!.comparable_group_key).toBe("us:equity:all");
    }
    // clamp01((score - 45) / (80 - 45)): 45→0, 62.5→0.5, 80→1.
    expect(res.get("A")!.rank_pct).toBeCloseTo((45 - RANK_FLOOR_LO) / (RANK_FLOOR_HI - RANK_FLOOR_LO), 10);
    expect(res.get("B")!.rank_pct).toBeCloseTo(0.5, 10);
    expect(res.get("C")!.rank_pct).toBeCloseTo(1, 10);
  });

  it("India equity groups use the India min sample (15)", () => {
    const mk = (sym: string, score: number): RankCandidate => ({
      symbol: sym, analystScore: score, market: "india", assetType: "equity",
      sector: "financials", evidenceConfidence: 0.9, direction: "long", isHeld: false,
    });
    // 15 names hits the India threshold exactly → 'ok'; 14 would be degraded.
    const ok15 = computeComparableRank(Array.from({ length: RANK_MIN_GROUP_EQUITY_INDIA }, (_, i) => mk(`I${i}`, 50 + i)));
    expect(ok15.every(r => r.rank_quality === "ok")).toBe(true);
    expect(ok15[0].comparable_group_key).toBe("india:equity:Financials");
    const deg14 = computeComparableRank(Array.from({ length: RANK_MIN_GROUP_EQUITY_INDIA - 1 }, (_, i) => mk(`I${i}`, 50 + i)));
    expect(deg14.every(r => r.rank_quality === "degraded")).toBe(true);
    expect(deg14.every(r => r.comparable_group_key === "india:equity:all")).toBe(true);
  });

  it("US equity sector group needs >= 20 eligible names to be 'ok'", () => {
    const at20 = computeComparableRank(Array.from({ length: RANK_MIN_GROUP_EQUITY_US }, (_, i) => usEquity(`T${i}`, 50 + i)));
    expect(at20.every(r => r.rank_quality === "ok")).toBe(true);
    const at19 = computeComparableRank(Array.from({ length: RANK_MIN_GROUP_EQUITY_US - 1 }, (_, i) => usEquity(`T${i}`, 50 + i)));
    expect(at19.every(r => r.rank_quality === "degraded")).toBe(true);
  });
});

describe("computeComparableRank — data-quality exclusions (rank composites after gates)", () => {
  it("excludes held, abstained, and low-confidence names with rank_pct null + rank_eligible false", () => {
    const cands: RankCandidate[] = [
      usEquity("GOOD", 70),
      { ...usEquity("HELD", 70), isHeld: true },
      { ...usEquity("ABSTAIN", 70), direction: "neutral" },
      { ...usEquity("LOWCONF", 70), evidenceConfidence: 0.4 },
    ];
    const res = bySymbol(computeComparableRank(cands));
    expect(res.get("HELD")!.rank_eligible).toBe(false);
    expect(res.get("HELD")!.rank_pct).toBeNull();
    expect(res.get("HELD")!.rank_quality).toBe("excluded_held");
    expect(res.get("ABSTAIN")!.rank_quality).toBe("excluded_abstain");
    expect(res.get("ABSTAIN")!.rank_pct).toBeNull();
    expect(res.get("LOWCONF")!.rank_quality).toBe("excluded_conf");
    expect(res.get("LOWCONF")!.rank_pct).toBeNull();
    // The one eligible name is ranked; excluded names do not inflate the pool.
    expect(res.get("GOOD")!.rank_eligible).toBe(true);
    expect(res.get("GOOD")!.group_n).toBe(1);
  });

  it("excluded symbols never enter their comparable group's sample count", () => {
    // 19 eligible tech + 5 held tech: eligible count is 19 (< 20) → degraded, held excluded.
    const cands: RankCandidate[] = [
      ...Array.from({ length: 19 }, (_, i) => usEquity(`T${i}`, 55 + i)),
      ...Array.from({ length: 5 }, (_, i) => ({ ...usEquity(`H${i}`, 60), isHeld: true })),
    ];
    const res = bySymbol(computeComparableRank(cands));
    expect(res.get("T0")!.rank_quality).toBe("degraded"); // 19 eligible < 20
    expect(res.get("T0")!.group_n).toBe(19);
    expect(res.get("H0")!.rank_eligible).toBe(false);
  });
});

describe("isRankRejected — the hybrid gate's rank half", () => {
  const eligibleMid: RankResult = {
    symbol: "M", rank_pct: 0.4, rank_quality: "ok", comparable_group_key: "us:equity:Information Technology", group_n: 25, rank_eligible: true,
  };
  const eligibleHigh: RankResult = { ...eligibleMid, symbol: "H", rank_pct: 0.9 };
  const excluded: RankResult = {
    symbol: "X", rank_pct: null, rank_quality: "excluded_conf", comparable_group_key: null, group_n: null, rank_eligible: false,
  };

  it("DEFAULT rank_pct_min = 0 rejects NOTHING (behavior-identical proof)", () => {
    expect(isRankRejected(eligibleMid, 0)).toBe(false);
    expect(isRankRejected(eligibleHigh, 0)).toBe(false);
    expect(isRankRejected(excluded, 0)).toBe(false);      // even an excluded name
    expect(isRankRejected(undefined, 0)).toBe(false);
  });

  it("a raised threshold removes only below-rank candidates, keeps above-rank", () => {
    expect(isRankRejected(eligibleMid, 0.6)).toBe(true);  // 0.4 < 0.6 → rejected
    expect(isRankRejected(eligibleHigh, 0.6)).toBe(false); // 0.9 >= 0.6 → kept
  });

  it("when the gate is active a non-eligible long is rejected (failed §4.1)", () => {
    expect(isRankRejected(excluded, 0.6)).toBe(true);
    expect(isRankRejected(undefined, 0.6)).toBe(true);
  });
});

describe("selection behavior-identity & subset property (top-3 / long-only / SELL preserved)", () => {
  // Mirrors the cron's Pass-2 gate loop over NEW long candidates to prove the
  // OFF-by-default selection equals pre-feature selection, and that a raised
  // threshold can only shrink the actionable set.
  function actionableLongs(cands: RankCandidate[], rankPctMin: number): string[] {
    const ranked = new Map(computeComparableRank(cands).map(r => [r.symbol, r]));
    return cands
      .filter(c => !c.isHeld && c.direction === "long")           // long-only, new positions
      .filter(c => !isRankRejected(ranked.get(c.symbol), rankPctMin))
      .map(c => c.symbol);
  }

  // A realistic small mixed universe: 3 long finalists, 1 held (SELL path), 1 abstain.
  const universe: RankCandidate[] = [
    usEquity("AAA", 72),
    usEquity("BBB", 66),
    usEquity("CCC", 61),
    { ...usEquity("HELD1", 55), isHeld: true, direction: "short" }, // a held SELL signal
    { ...usEquity("ABS1", 70), direction: "neutral" },             // abstained
  ];

  it("rank_pct_min = 0.0 → actionable set is IDENTICAL to the pre-feature floor survivors", () => {
    // Pre-feature: every long, non-held candidate is actionable (floor already applied upstream).
    const preFeature = universe.filter(c => !c.isHeld && c.direction === "long").map(c => c.symbol);
    expect(actionableLongs(universe, 0.0)).toEqual(preFeature);
    expect(actionableLongs(universe, 0.0)).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("rank_pct_min > 0 → actionable set is a SUBSET of the floor survivors (never larger)", () => {
    const off = actionableLongs(universe, 0.0);
    const on = actionableLongs(universe, 0.6);
    expect(on.length).toBeLessThanOrEqual(off.length);
    expect(on.every(s => off.includes(s))).toBe(true);
  });

  it("held-position SELL/exit signals are unaffected by any rank_pct_min value", () => {
    // HELD1 is a short/exit on a held name — it is never in the long actionable set,
    // regardless of threshold, so the SELL path is untouched.
    for (const thr of [0.0, 0.5, 0.9]) {
      expect(actionableLongs(universe, thr)).not.toContain("HELD1");
    }
  });

  it("never expands beyond the ≤3/day finalists — a raised gate only tightens", () => {
    expect(actionableLongs(universe, 0.0).length).toBeLessThanOrEqual(3);
    expect(actionableLongs(universe, 0.9).length).toBeLessThanOrEqual(3);
  });
});
