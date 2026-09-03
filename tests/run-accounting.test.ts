import { describe, it, expect } from "vitest";
import {
  evaluateRunAccounting,
  parseRunAccounting,
  runAccountingEnvelope,
  type RunAccounting,
} from "@/lib/monitoring/run-accounting";
import {
  evaluateFreshness,
  FRESHNESS_CONTRACTS,
  type FreshnessContract,
} from "@/lib/monitoring/freshness-contracts";

function acct(over: Partial<RunAccounting> = {}): RunAccounting {
  return {
    job: "label_maturation",
    market: "us",
    eligible: 0, succeeded: 0, expectedSkip: 0, deferred: 0, unavailable: 0, failed: 0,
    ...over,
  };
}

describe("run accounting — within-run reconciliation", () => {
  it("a healthy ZERO-OUTPUT run does not alert", () => {
    // The refuted design (assertProductiveRun) would fire here. Production
    // returns {"skipped":true,"reason":"weekend + shallow backlog","backlog":0}
    // and that is correct behaviour, not a defect.
    const v = evaluateRunAccounting(acct({ eligible: 0 }));
    expect(v.state).toBe("no_work");
    expect(v.healthy).toBe(true);
    expect(v.findings).toEqual([]);
  });

  it("zero business metrics never make a run unhealthy", () => {
    const v = evaluateRunAccounting(acct({
      job: "position_monitor",
      eligible: 9, succeeded: 9,
      businessMetrics: { positions_closed: 0, trades_filled: 0 },
    }));
    expect(v.state).toBe("completed");
    expect(v.healthy).toBe(true);
  });

  it("unavailable eligible work with zero successes ALERTS, and carries the blocker reason", () => {
    // The 2026-08 incident, exactly: {"success":true,"matured":0,"skipped":800}.
    const v = evaluateRunAccounting(acct({
      eligible: 800, unavailable: 800,
      blockers: ["price_cache slice non-empty but stale, provider fallback unreachable"],
      skipReasons: { stale_cache_hit: 800 },
    }));
    expect(v.state).toBe("blocked");
    expect(v.healthy).toBe(false);
    expect(v.findings.map((f) => f.code)).toContain("blocked_run");
    expect(v.findings[0].detail).toContain("provider fallback unreachable");
  });

  it("a blocked run with NO named blocker still alerts and says so", () => {
    const v = evaluateRunAccounting(acct({ eligible: 12, deferred: 12 }));
    expect(v.healthy).toBe(false);
    expect(v.findings[0].detail).toContain("named no blocker");
  });

  it("all legitimate expected skips are healthy no-action", () => {
    const v = evaluateRunAccounting(acct({
      job: "paper_trader",
      eligible: 10,
      expectedSkip: 10,
      skipReasons: { exposure_cap: 8, reentry_cooldown: 2 },
    }));
    expect(v.state).toBe("no_action");
    expect(v.healthy).toBe(true);
    expect(v.findings).toEqual([]);
  });

  it("does not call a mixed expected-skip and unavailable run fully blocked", () => {
    const v = evaluateRunAccounting(acct({
      job: "paper_trader",
      eligible: 16,
      expectedSkip: 13,
      unavailable: 3,
      skipReasons: { no_eligible_signal: 13, stale_quote: 3 },
      blockers: ["three symbols had no same-session quote"],
    }));
    expect(v.state).toBe("partial");
    expect(v.healthy).toBe(false);
    expect(v.findings.map((f) => f.code)).toEqual(["partial_unavailable"]);
    expect(v.findings[0].title).not.toContain("0 succeeded");
    expect(v.findings[0].detail).toContain("13 unit(s) were legitimate no-action decisions");
  });

  it("any failed unit alerts, even when most units succeeded", () => {
    const v = evaluateRunAccounting(acct({
      job: "position_monitor", eligible: 11, succeeded: 10, failed: 1,
      blockers: ["execute_paper_exit failed (LNC): existing_open_position"],
    }));
    expect(v.state).toBe("partial");
    expect(v.healthy).toBe(false);
    expect(v.findings.map((f) => f.code)).toEqual(["failed_units"]);
  });

  it("all units failed => state failed", () => {
    const v = evaluateRunAccounting(acct({ eligible: 3, failed: 3 }));
    expect(v.state).toBe("failed");
    expect(v.findings.map((f) => f.code)).toEqual(["failed_units", "blocked_run"]);
  });

  it("an impossible reconciliation alerts as critical", () => {
    const v = evaluateRunAccounting(acct({ eligible: 100, succeeded: 40, expectedSkip: 10 }));
    expect(v.reconciles).toBe(false);
    expect(v.findings.find((f) => f.code === "reconciliation_mismatch")?.severity).toBe("critical");
    expect(v.findings[0].title).toContain("50 unit(s) unaccounted for");
  });

  it("negative or non-finite counts are rejected outright", () => {
    const v = evaluateRunAccounting(acct({ eligible: 5, succeeded: -1, expectedSkip: 6 }));
    expect(v.findings.map((f) => f.code)).toContain("negative_counts");
  });

  it("deferred/unavailable work downgrades a run to partial without failing it", () => {
    const v = evaluateRunAccounting(acct({ eligible: 10, succeeded: 7, unavailable: 2, deferred: 1 }));
    expect(v.state).toBe("partial");
    expect(v.healthy).toBe(true);
  });
});

describe("run accounting — envelope round trip", () => {
  it("survives the envelope and a JSON string result_summary", () => {
    const a = acct({ eligible: 4, succeeded: 4, highWatermark: "2026-08-15" });
    const env = runAccountingEnvelope(a);
    expect(parseRunAccounting(env)?.eligible).toBe(4);
    expect(parseRunAccounting(JSON.stringify(env))?.job).toBe("label_maturation");
  });

  it("a plain-text summary parses as UNKNOWN, never as healthy", () => {
    expect(parseRunAccounting("EdgeScout (measure-only): 12 edge_signals.")).toBeNull();
    expect(parseRunAccounting(null)).toBeNull();
    expect(parseRunAccounting({ matured: 0, skipped: 800 })).toBeNull();
  });
});

const priceCache = FRESHNESS_CONTRACTS.find((c) => c.id === "price-cache-us-symbols")!;
const labels = FRESHNESS_CONTRACTS.find((c) => c.id === "observation-labels-maturation")!;
const NOW = new Date("2026-08-13T22:00:00Z");

describe("freshness contracts — cross-run watermark advance", () => {
  it("a stalled high-watermark alerts", () => {
    const r = evaluateFreshness(labels, [{ watermark: "2026-07-22T21:00:00Z" }], NOW);
    expect(r.breached).toBe(true);
    expect(r.kind).toBe("stale");
    expect(r.detail).toContain("not advancing");
  });

  it("a watermark inside the grace window does not alert", () => {
    const r = evaluateFreshness(labels, [{ watermark: "2026-08-13T02:00:00Z" }], NOW);
    expect(r.breached).toBe(false);
  });

  it("PER-SYMBOL: aggregate max(date) healthy while most symbols are frozen", () => {
    // The real defect. 101/140 symbols sat at Jul 22 while table-wide max(date)
    // read Aug 13, so every aggregate check passed.
    const rows = [
      ...Array.from({ length: 39 }, (_, i) => ({ scope: `FRESH${i}`, watermark: "2026-08-13" })),
      ...Array.from({ length: 101 }, (_, i) => ({ scope: `FROZEN${i}`, watermark: "2026-07-22" })),
    ];
    const r = evaluateFreshness(priceCache, rows, NOW);
    expect(r.breached).toBe(true);
    expect(r.kind).toBe("coverage");
    expect(r.totalScopes).toBe(140);
    expect(r.staleScopes).toHaveLength(101);
    expect(r.newestWatermark).toContain("2026-08-13"); // aggregate looks fine
    expect(r.detail).toContain("hiding them");
  });

  it("a weekend does not trip a daily-bar contract", () => {
    const monday = new Date("2026-08-17T13:00:00Z");
    const rows = Array.from({ length: 20 }, (_, i) => ({ scope: `S${i}`, watermark: "2026-08-14" }));
    expect(evaluateFreshness(priceCache, rows, monday).breached).toBe(false);
  });

  it("a few laggard symbols stay under the coverage floor", () => {
    const rows = [
      ...Array.from({ length: 137 }, (_, i) => ({ scope: `F${i}`, watermark: "2026-08-13" })),
      ...Array.from({ length: 3 }, (_, i) => ({ scope: `DELISTED${i}`, watermark: "2026-07-22" })),
    ];
    expect(evaluateFreshness(priceCache, rows, NOW).breached).toBe(false);
  });

  it("an empty read is UNKNOWN and alerts — it is never proof of health", () => {
    const r = evaluateFreshness(priceCache, [], NOW);
    expect(r.breached).toBe(true);
    expect(r.kind).toBe("empty");
  });

  it("the registry has unique ids and sane thresholds", () => {
    const ids = FRESHNESS_CONTRACTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of FRESHNESS_CONTRACTS as FreshnessContract[]) {
      expect(c.graceHours).toBeGreaterThan(0);
      expect(c.minCoverage).toBeGreaterThan(0);
      expect(c.minCoverage).toBeLessThanOrEqual(1);
      expect(c.impact.length).toBeGreaterThan(20);
      expect(c.recovery.length).toBeGreaterThan(10);
    }
  });

  it("a required scope with no cache row remains in the denominator and alerts", () => {
    const r = evaluateFreshness(priceCache, [
      { scope: "FRESH", watermark: "2026-08-13" },
      { scope: "MISSING", watermark: null },
    ], NOW);
    expect(r.totalScopes).toBe(2);
    expect(r.coverage).toBe(0.5);
    expect(r.staleScopes).toEqual(["MISSING"]);
    expect(r.breached).toBe(true);
  });

  it("the US price contract monitors the active universe, not retired cache symbols", () => {
    expect(priceCache.scopeUniverse).toBe("active_us_price_symbols");
  });
});

describe("stale-check: status='error' is not 'ran'", () => {
  // Mirrors the route's own predicate. The route counted ANY matching row as
  // proof the job ran; the two failed 2026-08-13/14 PositionMonitor runs
  // therefore read as healthy.
  const isTerminalSuccess = (r: { status: string }) => /^(done|completed|success|succeeded|skipped)$/i.test(String(r?.status ?? ""));
  const ranFrom = (rows: Array<{ status: string }>) => rows.some(isTerminalSuccess);

  it("an errored run alone does not satisfy the schedule", () => {
    expect(ranFrom([{ status: "error" }])).toBe(false);
    expect(ranFrom([{ status: "failed" }])).toBe(false);
  });

  it("a completed run does", () => {
    expect(ranFrom([{ status: "done" }])).toBe(true);
    expect(ranFrom([{ status: "error" }, { status: "done" }])).toBe(true);
  });

  it("no rows at all is still a miss", () => {
    expect(ranFrom([])).toBe(false);
  });

  it("a running or unknown-status row does not satisfy the schedule", () => {
    expect(ranFrom([{ status: "running" }])).toBe(false);
    expect(ranFrom([{ status: "queued" }])).toBe(false);
  });
});
