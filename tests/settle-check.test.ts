import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compareSettledMarks, SETTLE_TOLERANCE_PCT } from "@/lib/paper/settle-check";

const mk = (symbol: string, markPrice: number, qty = 10, provenance = "live_quote") =>
  ({ symbol, qty, markPrice, provenance, source: "yahoo" });

describe("settle check — yesterday's marks vs the authoritative close", () => {
  it("corroborates marks that match the settled closes", () => {
    const r = compareSettledMarks("2026-08-19", [mk("NVDA", 217.56), mk("XAR", 284.10)],
      { NVDA: 217.56, XAR: 284.10 });
    expect(r.verdict).toBe("corroborated");
    expect(r.compared).toBe(2);
    expect(r.worstDriftPct).toBeCloseTo(0, 6);
    expect(r.navDrift).toBeCloseTo(0, 6);
  });

  it("tolerates a small settlement revision — the measured KGC 0.07% case", () => {
    const r = compareSettledMarks("2026-08-19", [mk("KGC", 29.92)], { KGC: 29.90 });
    expect(r.verdict).toBe("corroborated");
    expect(r.worstDriftPct).toBeLessThan(SETTLE_TOLERANCE_PCT);
  });

  it("flags a real mismarking and quantifies its NAV impact", () => {
    // The AV-stale case: marked 219.74 when the session settled at 217.56.
    const r = compareSettledMarks("2026-08-19", [mk("NVDA", 219.74, 5)], { NVDA: 217.56 });
    expect(r.verdict).toBe("drift_detected");
    expect(r.beyond).toHaveLength(1);
    expect(r.beyond[0].driftPct).toBeCloseTo(1.002, 2);
    expect(r.navDrift).toBeCloseTo((219.74 - 217.56) * 5, 6);
  });

  it("does NOT re-flag marks already labelled stale", () => {
    const r = compareSettledMarks("2026-08-19",
      [mk("BAC", 64.09, 10, "carry_forward"), mk("MSFT", 487.65, 10, "entry_cost")],
      { BAC: 63.18, MSFT: 481.63 });
    expect(r.compared).toBe(0);
    expect(r.verdict).toBe("nothing_to_compare");
  });

  it("counts a missing authoritative close as UNVERIFIABLE, never as agreement", () => {
    const r = compareSettledMarks("2026-08-19", [mk("NVDA", 217.56), mk("DELISTED", 5)],
      { NVDA: 217.56 });
    expect(r.unverifiable).toEqual(["DELISTED"]);
    expect(r.compared).toBe(1);
  });

  it("an empty grouped feed is 'nothing_to_compare', not 'corroborated'", () => {
    // The feed not being published yet must never read as a clean bill of health.
    const r = compareSettledMarks("2026-08-19", [mk("NVDA", 217.56)], {});
    expect(r.verdict).toBe("nothing_to_compare");
    expect(r.unverifiable).toEqual(["NVDA"]);
  });

  it("nets signed drift so opposite errors do not cancel in the per-symbol view", () => {
    const r = compareSettledMarks("2026-08-19", [mk("A", 110, 1), mk("B", 90, 1)], { A: 100, B: 100 });
    expect(r.navDrift).toBeCloseTo(0, 6);        // net is zero
    expect(r.beyond).toHaveLength(2);            // but BOTH are still flagged
    expect(r.verdict).toBe("drift_detected");
  });
});

// Route-shaped: the settle pass must never write money state. A pure test of
// compareSettledMarks cannot see what the route does with the result.
describe("the settle pass writes no money state", () => {
  const route = readFileSync("app/api/agents/settle-check/route.ts", "utf8");

  it("never updates nav, positions, or trades", () => {
    const updateBodies = route.split('.update({').slice(1).map((chunk) => chunk.split('}).eq')[0]);
    for (const body of updateBodies) expect(body).not.toMatch(/\bnav\s*:/);
    expect(route).not.toContain('from("paper_positions")');
    expect(route).not.toContain('from("paper_trades")');
  });

  it("taints the row instead of restating it", () => {
    expect(route).toContain("tainted: true");
    expect(route).toContain("taint_reason");
    expect(route).toContain("nav is NOT restated");
  });

  it("does not resolve the alert when there was nothing to compare", () => {
    // An unpublished feed must not read as a clean bill of health.
    const resolveAt = route.indexOf("resolveIssue(issueKey");
    const corroboratedAt = route.indexOf('result.verdict === "corroborated"');
    expect(corroboratedAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(corroboratedAt);
    expect(route).toContain("nothing_to_compare` deliberately neither raises nor resolves");
  });

  it("settles the last COMPLETED session, not today", () => {
    expect(route).toContain("lastCompletedMarketSession(\"us\")");
  });
});
