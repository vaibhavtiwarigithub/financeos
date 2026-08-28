import { describe, it, expect } from "vitest";
import {
  runA0DataTruth, runA1Funnel, runA3Payoff, quintileSpread,
  type NavRow, type FunnelRow, type ClosedLot,
} from "./alpha-diagnostics";
import {
  canonicalize, fingerprint, fingerprintDataset, resolveVerdict, sampleStatus, MIN_REVIEW_DATES,
  type DiagnosticFinding,
} from "./alpha-diagnostic-contract";

function navRow(over: Partial<NavRow> = {}): NavRow {
  return {
    date: "2026-08-19", nav: 100, cashBalance: 40, positionsValue: 60,
    benchNav: 700, benchSessionDate: "2026-08-19", benchSource: "yahoo(settled)",
    ...over,
  };
}

describe("A0 data truth", () => {
  it("passes when every invariant holds", () => {
    const { finding } = runA0DataTruth("us", [navRow(), navRow({ date: "2026-08-20", benchSessionDate: "2026-08-20" })]);
    expect(finding.status).toBe("pass");
  });

  it("fails when NAV does not reconcile to cash plus positions", () => {
    const { finding, invariants } = runA0DataTruth("us", [navRow({ positionsValue: 59 })]);
    expect(finding.status).toBe("fail");
    expect(invariants.find(i => i.id === "nav_reconciles")!.ok).toBe(false);
  });

  // The 2026-08-12 incident: VOO's 08-11 close stored under both 08-12 and 08-13.
  it("fails when the benchmark belongs to a different session than the NAV row", () => {
    const { finding, invariants } = runA0DataTruth("us", [navRow({ benchSessionDate: "2026-08-18" })]);
    expect(finding.status).toBe("fail");
    expect(invariants.find(i => i.id === "bench_session_matches_row")!.ok).toBe(false);
  });

  // The 2026-08-19..27 incident: a provisional value passing as settled.
  it("fails when a stored benchmark has no provenance", () => {
    const { finding } = runA0DataTruth("us", [navRow({ benchSource: null })]);
    expect(finding.status).toBe("fail");
  });

  it("allows an explicit leading cash-only inception row", () => {
    const inception = navRow({ nav: 100, cashBalance: 100, positionsValue: 0, benchNav: null, benchSource: null, benchSessionDate: null });
    const { finding } = runA0DataTruth("us", [inception, navRow({ date: "2026-08-20", benchSessionDate: "2026-08-20" })]);
    expect(finding.status).toBe("pass");
    expect(finding.metrics.leadingInceptionRows).toBe(1);
  });

  it("fails a missing benchmark after coverage has begun", () => {
    const { finding } = runA0DataTruth("us", [
      navRow(),
      navRow({ date: "2026-08-20", benchNav: null, benchSource: null, benchSessionDate: null }),
    ]);
    expect(finding.status).toBe("fail");
    expect(finding.coverage).toBeLessThan(1);
  });

  it("fails duplicate dates and missing NAV components", () => {
    const { finding, invariants } = runA0DataTruth("us", [navRow(), navRow({ cashBalance: null })]);
    expect(finding.status).toBe("fail");
    expect(invariants.find(i => i.id === "unique_session_date")?.ok).toBe(false);
    expect(invariants.find(i => i.id === "nav_components_present")?.ok).toBe(false);
  });

  it("reports insufficient_evidence rather than passing an empty window", () => {
    expect(runA0DataTruth("us", []).finding.status).toBe("insufficient_evidence");
  });
});

describe("A1 funnel", () => {
  function rows(n: number): FunnelRow[] {
    const out: FunnelRow[] = [];
    for (let d = 0; d < n; d++) {
      const date = `2026-06-${String((d % 28) + 1).padStart(2, "0")}`;
      out.push({ date, symbol: "AAA", stage: "closed", benchmarkNeutralReturn: 0.02, attritionReason: null });
      out.push({ date, symbol: "BBB", stage: "entry_eligible", benchmarkNeutralReturn: -0.01, attritionReason: "max_open_names" });
    }
    return out;
  }

  it("counts a later-stage row in every earlier stage", () => {
    const f = runA1Funnel("us", rows(1), 10, 1);
    const stages = f.metrics.stages as any[];
    expect(stages.find(s => s.stage === "scored").count).toBe(2);
    expect(stages.find(s => s.stage === "selected").count).toBe(1);
    expect(stages.find(s => s.stage === "closed").count).toBe(1);
  });

  it("tallies deterministic attrition reasons", () => {
    const f = runA1Funnel("us", rows(2), 10, 1);
    expect((f.metrics.attrition as any).max_open_names).toBe(2);
  });

  it("refuses interpretation below the date floor", () => {
    expect(runA1Funnel("us", rows(3), 10, 20).status).toBe("insufficient_evidence");
  });
});

describe("sampleStatus overlap correction", () => {
  it("refuses a long horizon whose windows overlap, even past the date floor", () => {
    // 20 dates clears any date floor of 20, but at h120 that is 0.17 independent
    // observations -- the exact false-confidence case.
    const s = sampleStatus({ nRows: 200, nDates: 20, nSymbols: 10, horizonDays: 120 }, 20);
    expect(s.ok).toBe(false);
    expect(s.reason).toContain("independent observations");
  });

  it("allows a short horizon at the same date count", () => {
    expect(sampleStatus({ nRows: 200, nDates: 30, nSymbols: 10, horizonDays: 2 }, 20).ok).toBe(true);
  });
});

describe("quintileSpread", () => {
  it("is positive when higher scores earn higher forward returns", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      date: "2026-08-19", symbol: `S${i}`, score: i, forwardReturn: i * 0.001,
    }));
    const q = quintileSpread(rows);
    expect(q.spread!).toBeGreaterThan(0);
    expect(q.perBucket).toHaveLength(5);
  });

  it("is negative when the ranking is backwards", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      date: "2026-08-19", symbol: `S${i}`, score: i, forwardReturn: -i * 0.001,
    }));
    expect(quintileSpread(rows).spread!).toBeLessThan(0);
  });

  it("returns null rather than a number it cannot support", () => {
    expect(quintileSpread([]).spread).toBeNull();
  });
});

describe("A3 payoff geometry", () => {
  function lot(over: Partial<ClosedLot> = {}): ClosedLot {
    return { symbol: "AAA", market: "us", realizedPnl: 10, pnlPct: 5, mfe: 0.08, mae: -0.02, exitReason: "time_stop", entryDate: "2026-08-01", exitDate: "2026-08-12", ...over };
  }

  // The failure mode both profit factors exist to separate: the POLICY picked
  // winners (percent PF >= 1) but the ALLOCATION lost money (currency PF < 1).
  it("reports an allocation divergence without assigning sizing causality", () => {
    const f = runA3Payoff("us", [
      lot({ realizedPnl: 5,    pnlPct: 10 }),   // small winner, big %
      lot({ realizedPnl: -50,  pnlPct: -9 }),   // large loser, smaller %
    ]);
    expect(f.metrics.percentProfitFactor as number).toBeGreaterThanOrEqual(1);
    expect(f.metrics.currencyProfitFactor as number).toBeLessThan(1);
    expect(f.metrics.allocationDivergenceObserved).toBe(true);
  });

  it("does not flag sizing damage when both profit factors agree", () => {
    const f = runA3Payoff("us", [lot({ realizedPnl: 50, pnlPct: 10 }), lot({ realizedPnl: -5, pnlPct: -1 })]);
    expect(f.metrics.allocationDivergenceObserved).toBe(false);
  });

  it("counts losers that were previously in profit", () => {
    const f = runA3Payoff("us", [
      lot({ realizedPnl: -10, pnlPct: -3, mfe: 0.06 }),  // gave back a gain
      lot({ realizedPnl: -10, pnlPct: -3, mfe: 0 }),      // never went favourable
    ]);
    expect(f.metrics.priorPositiveLosers).toBe(1);
    expect(f.metrics.priorPositiveLoserShare).toBeCloseTo(0.5, 6);
  });

  it("returns insufficient_evidence on an empty cohort instead of zeros", () => {
    expect(runA3Payoff("us", []).status).toBe("insufficient_evidence");
  });

  it("does not convert a missing realized outcome into a flat trade", () => {
    const f = runA3Payoff("us", [
      lot({ realizedPnl: Number.NaN, pnlPct: Number.NaN }),
      lot({ realizedPnl: 10, pnlPct: 5 }),
    ]);
    expect(f.metrics.outcomeLots).toBe(1);
    expect(f.metrics.outcomeCoverage).toBe(0.5);
    expect(f.metrics.winRate).toBe(1);
  });
});

describe("canonicalize / fingerprint", () => {
  it("is insensitive to key order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("collapses -0 and 0 so the fingerprint does not split on sign", () => {
    expect(canonicalize({ x: -0 })).toBe(canonicalize({ x: 0 }));
  });

  it("emits null for non-finite numbers rather than invalid JSON", () => {
    expect(canonicalize({ x: Number.NaN })).toBe('{"x":null}');
    expect(() => JSON.parse(canonicalize({ x: Infinity }))).not.toThrow();
  });

  it("gives identical fingerprints to identical content and different to different", () => {
    expect(fingerprint({ a: 1, b: [2, 3] })).toBe(fingerprint({ b: [2, 3], a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe("resolveVerdict", () => {
  const f = (over: Partial<DiagnosticFinding>): DiagnosticFinding => ({
    market: "us", testId: "A2", cohort: "learning",
    window: { from: "", to: "" }, sample: { nRows: 0, nDates: 0, nSymbols: 0 },
    coverage: 1, metricVersion: "v", status: "descriptive_only", reason: "", metrics: {},
    ...over,
  });

  // A0 is a hard gate: a downstream `pass` cannot outvote broken data.
  it("returns data_invalid when A0 failed, regardless of other passes", () => {
    expect(resolveVerdict([f({ testId: "A0", status: "fail" }), f({ status: "pass" })])).toBe("data_invalid");
  });

  it("returns reject_candidate on a non-A0 failure", () => {
    expect(resolveVerdict([f({ status: "fail" })])).toBe("reject_candidate");
  });

  // The absence of failure is not evidence of success.
  it("returns collect_more when nothing actually passed", () => {
    expect(resolveVerdict([f({ status: "descriptive_only" }), f({ status: "insufficient_evidence" })])).toBe("collect_more");
  });

  it("reaches owner_review only on a genuine pass", () => {
    expect(resolveVerdict([f({ status: "pass" })])).toBe("owner_review");
  });

  it("never returns a promotion verdict — owner_review is the ceiling", () => {
    const verdicts = [
      resolveVerdict([f({ status: "pass" })]),
      resolveVerdict([f({ status: "fail" })]),
      resolveVerdict([]),
    ];
    expect(verdicts).not.toContain("promote");
    expect(MIN_REVIEW_DATES).toBeGreaterThanOrEqual(60);
  });
});

describe("fingerprint", () => {
  // backtest_experiments constrains every fingerprint column to
  // ^[0-9a-f]{64}$. A shorter digest is rejected at INSERT, which is exactly
  // how the first production run of this feature failed.
  it("matches the registry's required 64-hex shape", () => {
    expect(fingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  // Duplicating one pass would make chunks identical and silently collapse the
  // digest space while still satisfying the regex.
  it("emits eight DISTINCT 32-bit chunks", () => {
    for (const v of [{ a: 1 }, { b: "x" }, [1, 2, 3], { nested: { k: 9 } }]) {
      const fp = fingerprint(v);
      const chunks = fp.match(/.{8}/g)!;
      expect(chunks).toHaveLength(8);
      expect(new Set(chunks).size).toBe(8);
    }
  });

  it("changes when a deeply nested value changes", () => {
    expect(fingerprint({ a: { b: { c: 1 } } })).not.toBe(fingerprint({ a: { b: { c: 2 } } }));
  });

  it("is stable across repeated calls", () => {
    const v = { z: 1, a: [3, 2, 1], n: { q: 0.1 + 0.2 } };
    expect(fingerprint(v)).toBe(fingerprint(v));
  });

  it("changes when data changes even if counts and date endpoints do not", () => {
    const before = { performance: [{ date: "d1", nav: 100 }, { date: "d2", nav: 101 }] };
    const after = { performance: [{ date: "d1", nav: 100 }, { date: "d2", nav: 99 }] };
    expect(fingerprintDataset(before)).not.toBe(fingerprintDataset(after));
    expect(fingerprintDataset(before)).toBe(fingerprintDataset({ performance: [...before.performance].reverse() }));
  });
});

describe("resolveVerdict — A0 is a gate, not evidence", () => {
  const f = (testId: string, status: DiagnosticFinding["status"]): DiagnosticFinding => ({
    market: "us", testId, cohort: "learning",
    window: { from: "", to: "" }, sample: { nRows: 0, nDates: 0, nSymbols: 0 },
    coverage: 1, metricVersion: "v", status, reason: "", metrics: {},
  });

  // The first production run reported owner_review because A0 passed. "The
  // ledger reconciles" is not "a candidate is reviewable".
  it("does not promote a run whose only pass is A0", () => {
    expect(resolveVerdict([
      f("A0", "pass"),
      f("A3", "descriptive_only"),
      f("A7", "descriptive_only"),
    ])).toBe("collect_more");
  });

  it("promotes only on a candidate-establishing test", () => {
    expect(resolveVerdict([f("A0", "pass"), f("A8", "pass")])).toBe("owner_review");
  });

  it("still refuses when a candidate-establishing test failed", () => {
    expect(resolveVerdict([f("A0", "pass"), f("A8", "fail")])).toBe("reject_candidate");
  });
});
