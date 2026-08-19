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
    // 2026-08-18: no longer an unconditional literal — PositionMonitor is still
    // the ONLY writer that may produce `eod`, but only after that market's close.
    // A pre-close run writes `intraday` (see the market-scoping block below).
    expect(monitor).toMatch(/snapshot_type:.*"eod".*"intraday"/);
    expect(monitor).toContain("expectedNewestSession");
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

// ── 2026-08-18: a market-scoped run must touch ONLY its own market ───────────
//
// Both PositionMonitor crons are correctly scoped (`?market=us`, `?market=india`),
// yet the India run at 11:15 UTC wrote 13 US marks and a US `paper_performance`
// row stamped `snapshot_type='eod'` at 07:15 ET — before the US session opened.
// The scoping was defeated inside the route by two UNFILTERED reads: the
// `stillOpen` re-read of paper_positions, and the `poolByMarket` map that drives
// the mark/NAV write loop. Neither is reachable from a unit test of the helpers;
// both are shapes in the route.
describe("market scoping: a scoped run cannot write another market's book", () => {
  it("re-reads open positions scoped to the run's market", () => {
    // Assert the guard positively: the re-read must be built as a query that
    // gets a market filter before it is awaited. A negative on the select text
    // is useless — the same select survives, merely bound to a variable.
    expect(monitor).toContain('stillOpenQuery.eq("market", marketScope)');
    const buildAt = monitor.indexOf("let stillOpenQuery");
    const guardAt = monitor.indexOf('stillOpenQuery.eq("market", marketScope)');
    const awaitAt = monitor.indexOf("await stillOpenQuery");
    expect(buildAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(buildAt);
    expect(awaitAt).toBeGreaterThan(guardAt);
  });

  it("skips non-scoped markets in the mark/NAV write loop", () => {
    expect(monitor).toContain("if (marketScope && market !== marketScope) continue;");
    // The guard must sit inside the poolByMarket loop, before the write.
    // Newline-agnostic: this file's `code()` helper does not normalise CRLF.
    expect(monitor).toMatch(/for \(const pos of positions\)\s*\{\s*try\s*\{/);
    const loopAt = monitor.indexOf("for (const [market, pool] of poolByMarket)");
    const guardAt = monitor.indexOf("if (marketScope && market !== marketScope) continue;");
    const perfAt = monitor.indexOf('from("paper_performance").upsert');
    expect(guardAt).toBeGreaterThan(loopAt);
    expect(loopAt).toBeGreaterThan(-1);
    expect(perfAt).toBeGreaterThan(guardAt);
  });

  it("never hard-codes snapshot_type 'eod' — a pre-close row is 'intraday'", () => {
    // The unconditional literal is the defect: it stamped `eod` on a row built
    // from carry-forward marks hours before the market closed.
    expect(monitor).not.toMatch(/snapshot_type:\s*"eod"\s*,/);
    expect(monitor).toContain('expectedNewestSession(market as "us" | "india") === today ? "eod" : "intraday"');
  });
});

// ── 2026-08-18: one position's failure must not blank the whole book ─────────
//
// The 20:15 US run died on `execute_paper_exit denied (MSFT):
// position_lot_qty_mismatch`. The throw escaped the per-position loop and killed
// the run: no marks, no NAV, and the other 12 US positions never evaluated. The
// 2026-08-14 run died identically on LNC (`existing_open_position`).
//
// The RPC denial is CORRECT and must stay — MSFT's only lot closed on
// 2026-08-03 while its paper_positions row survived, so closing 0.472499 that no
// open lot backs would double-count a realized trade. The fix isolates the
// failure rather than silencing the guard.
describe("a single position's exit failure is isolated, not fatal", () => {
  it("wraps the per-position loop body and records the failure", () => {
    expect(monitor).toContain("const exitFailures:");
    // Newline-agnostic: this file's `code()` helper does not normalise CRLF.
    expect(monitor).toMatch(/for \(const pos of positions\)\s*\{\s*try\s*\{/);
    expect(monitor).toContain("exitFailures.push({");
  });

  it("still reaches the NAV/mark write after a failure", () => {
    // The whole point: marks and NAV are written even when a position threw.
    const catchAt = monitor.indexOf("exitFailures.push({");
    const navAt = monitor.indexOf('from("paper_performance").upsert');
    expect(catchAt).toBeGreaterThan(-1);
    expect(navAt).toBeGreaterThan(catchAt);
  });

  it("counts failures as FAILED units, so the run cannot report healthy", () => {
    expect(monitor).toContain("failed: exitFailures.length");
    expect(monitor).not.toMatch(/failed:\s*0\s*,\s*businessMetrics:\s*\{\s*closed/);
  });

  it("raises a critical naming the unevaluated symbols", () => {
    // BOTH the reportIssue and the resolveIssue must use the key. A bare
    // toContain passed even when the reportIssue key was renamed, because the
    // resolveIssue occurrence satisfied it — the assertion was decorative.
    const keyHits = monitor.split("position-monitor-exit-failed:").length - 1;
    expect(keyHits).toBeGreaterThanOrEqual(2);
    expect(monitor).toContain("stops/targets were NOT checked this run");
  });

  it("does NOT suppress the RPC denial — the guard still throws", () => {
    expect(monitor).toContain("execute_paper_exit denied (");
  });
});

// ── 2026-08-19: a disputed quote must not price an EXIT ─────────────────────
//
// The cross-check first landed only inside buildPositionMark, which runs AFTER
// the exit loop. It corrected the mark while the exit decision still used the
// disputed price: that run closed LULU at ~119.55 (the 08-14 price; 08-18 close
// was 119.01) and MSFT at ~487.65 (a carried 08-17 value; 08-18 close 481.63).
// The reason string even claimed the quote was "refused for stop/target
// evaluation" — it was not. The gate must sit on priceMap, before any exit.
describe("disputed quotes are refused BEFORE exits are evaluated", () => {
  it("gates priceMap, not just the mark", () => {
    expect(monitor).toContain("const disputedSymbols:");
    expect(monitor).toContain("delete priceMap[sym];");
  });

  it("the gate runs BEFORE the exit loop, not after", () => {
    const gateAt = monitor.indexOf("delete priceMap[sym];");
    const exitLoopAt = monitor.indexOf("for (const pos of positions)");
    const markAt = monitor.indexOf("buildPositionMark({");
    expect(gateAt).toBeGreaterThan(-1);
    expect(exitLoopAt).toBeGreaterThan(gateAt);   // exits see the gated map
    expect(markAt).toBeGreaterThan(gateAt);
  });

  it("raises a critical naming the refused symbols", () => {
    const hits = monitor.split("position-monitor-quote-disputed:").length - 1;
    expect(hits).toBeGreaterThanOrEqual(2); // report AND resolve paths
    expect(monitor).toContain("too doubtful to sell on");
  });
});
