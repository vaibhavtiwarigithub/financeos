// Route-shaped detectors for W4/W5 — the parts a pure function cannot reach.
//
// These are structural assertions over the route source, and they are honest
// about that. They exist because the three defects below are shapes, not
// values: an invariant that compares an expression with itself, a second writer
// upserting the canonical EOD key, and a benchmark level taken from a bare
// quote. Each is invisible to any unit test of the helpers, and each one shipped
// green for weeks.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Comments explain the very patterns being banned, so scan code only.
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const monitor = code("app/api/agents/position-monitor/route.ts");
const paperTrade = code("app/api/agents/paper-trade/route.ts");
const scorecard = code("app/api/agents/benchmark-scorecard/route.ts");

describe("W4: the NAV invariant compares independent sources", () => {
  it("no longer computes an 'expected' NAV from the same expression it checks", () => {
    expect(monitor).not.toMatch(/invariantExpected/);
  });

  it("re-reads the persisted book after the write and reconciles against the marks", () => {
    expect(monitor).toMatch(/from\("paper_portfolio"\)\s*\.select\("nav, cash_balance"\)/);
    expect(monitor).toMatch(/from\("paper_performance"\)\s*\.select\("nav"\)/);
    expect(monitor).toMatch(/reconcilePersistedNav\(/);
  });

  it("builds NAV from provenance-carrying marks, not a bare current_price reduce", () => {
    expect(monitor).toMatch(/buildPositionMark\(/);
    expect(monitor).toMatch(/navFromMarks\(/);
    expect(monitor).toMatch(/markLedgerRow\(/);
  });

  it("a NAV that fails to reconcile marks the run errored, not done", () => {
    expect(monitor).toMatch(/navBookFailed\s*=\s*navWriteFailed\s*\|\|\s*!navInvariantOk/);
    expect(monitor).toMatch(/status:\s*navBookFailed\s*\?\s*"error"\s*:\s*"done"/);
  });
});

describe("W4: one canonical EOD performance writer per market", () => {
  it("PositionMonitor is the EOD writer", () => {
    expect(monitor).toMatch(/snapshot_type:\s*"eod"/);
  });

  it("PaperTrader writes an intraday snapshot and never upserts the EOD key", () => {
    expect(paperTrade).toMatch(/snapshot_type:\s*"intraday"/);
    expect(paperTrade).not.toMatch(/from\("paper_performance"\)\.upsert/);
  });

  it("PaperTrader leaves an existing row for the session alone", () => {
    expect(paperTrade).toMatch(/if \(existingPerf\)/);
  });
});

describe("W5: benchmark levels come from session-dated bars, not quotes", () => {
  it("neither writer derives bench_nav from a benchmark quote any more", () => {
    for (const src of [monitor, paperTrade]) {
      expect(src).toMatch(/fetchBenchmarkObservation\(/);
      expect(src).not.toMatch(/getQuote\((\s*)benchSym/);
      expect(src).not.toMatch(/fetchIndiaQuote\((\s*)benchSym/);
    }
  });

  it("both persist the bar's own session date and source", () => {
    for (const src of [monitor, paperTrade]) {
      expect(src).toMatch(/bench_session_date:\s*benchSessionDate/);
      expect(src).toMatch(/bench_source:\s*benchSource/);
    }
  });

  it("the scorecard rejects a level proven to belong to another session", () => {
    expect(scorecard).toMatch(/session_mismatch/);
  });

  it("displayed coverage cannot exceed 100%", () => {
    expect(scorecard).toMatch(/Math\.min\(100, r\.coverage_pct\)/);
  });
});
