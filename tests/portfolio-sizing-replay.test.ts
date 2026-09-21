import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { replayPortfolioSizing, type SizingReplayPlan, type SizingTapeEvent } from "../lib/replay/portfolio-sizing";

const plan: SizingReplayPlan = {
  market: "us", initialCash: 10000, endAt: "2026-09-18T20:00:00Z",
  equalWeightPct: 8, riskBudgetPct: 0.5, maxNamePct: 12, maxSectorPct: 30,
  maxGrossPct: 80, additionalCostBps: 0, maxMarkAgeHours: 24,
};
const entry: SizingTapeEvent = { id: "buy", kind: "entry", entryId: "a", symbol: "AAA", sector: "tech",
  at: "2026-09-18T14:00:00Z", price: 100, stop: 95, stopObservedAt: "2026-09-18T13:59:00Z",
  entryStopVerified: true, tainted: false };
const marks: SizingTapeEvent = { id: "mark", kind: "mark", at: plan.endAt, prices: { AAA: 110 } };

describe("conditional portfolio sizing replay", () => {
  it("runs the read-only CLI and fingerprints its synthetic evidence", () => {
    const output = execFileSync(process.execPath, ["scripts/replay-portfolio-sizing.mjs", "tests/fixtures/portfolio-sizing-synthetic.json"], { encoding: "utf8" });
    const report = JSON.parse(output);
    expect(report.status).toBe("diagnostic");
    expect(report.evidenceClass).toBe("diagnostic_only");
    expect(report.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.engineSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.equalWeight.finalNav).toBe(10080);
  });
  it("compares the same winner with finite capital and retains open inventory", () => {
    const r = replayPortfolioSizing(plan, [entry, marks]);
    expect(r.status).toBe("diagnostic");
    if (r.status !== "diagnostic") return;
    expect(r.equalWeight.finalNav).toBe(10080);
    expect(r.equalRisk.finalNav).toBeCloseTo(10100, 3);
    expect(r.equalWeight.cash).toBe(9200);
    expect(r.incrementalReturnPct).toBeCloseTo(0.2, 3);
  });

  it("larger allocation also amplifies losses", () => {
    const r = replayPortfolioSizing(plan, [entry, { ...marks, prices: { AAA: 90 } }]);
    expect(r.status).toBe("diagnostic");
    if (r.status !== "diagnostic") return;
    expect(r.incrementalReturnPct).toBeCloseTo(-0.2, 3);
    expect(r.equalRisk.sampledMaxDrawdownPct).toBeCloseTo(1, 3);
  });

  it("replays partial sales against original quantity rather than residual quantity", () => {
    const r = replayPortfolioSizing(plan, [entry,
      { id: "half", kind: "exit", entryId: "a", at: "2026-09-18T15:00:00Z", price: 105, originalFraction: 0.5 },
      { id: "rest", kind: "exit", entryId: "a", at: plan.endAt, price: 120, originalFraction: 0.5 },
    ]);
    expect(r.status).toBe("diagnostic");
    if (r.status !== "diagnostic") return;
    expect(r.equalWeight.cash).toBe(10100);
    expect(r.equalWeight.finalNav).toBe(r.equalWeight.cash);
    expect(r.equalRisk.finalNav).toBeCloseTo(10125, 3);
  });

  it("enforces gross and sector limits across simultaneous holdings, including costs", () => {
    const other = { ...entry, id: "buy2", entryId: "b", symbol: "BBB" };
    const r = replayPortfolioSizing({ ...plan, maxSectorPct: 12, maxGrossPct: 12, additionalCostBps: 10 },
      [entry, other, { ...marks, prices: { AAA: 100, BBB: 100 } }]);
    expect(r.status).toBe("diagnostic");
    if (r.status !== "diagnostic") return;
    for (const arm of [r.equalWeight, r.equalRisk]) {
      expect(arm.cash).toBeGreaterThanOrEqual(0);
      expect(arm.tradedNotional / arm.finalNav).toBeLessThanOrEqual(0.12000001);
      expect(arm.costs).toBeCloseTo(arm.tradedNotional * 0.001);
    }
  });

  it("uses whole India shares and liquidates rounding residue at final exit", () => {
    const r = replayPortfolioSizing({ ...plan, market: "india", equalWeightPct: 9 }, [entry,
      { id: "half", kind: "exit", entryId: "a", at: "2026-09-18T15:00:00Z", price: 110, originalFraction: 0.5 },
      { id: "rest", kind: "exit", entryId: "a", at: plan.endAt, price: 120, originalFraction: 0.5 },
    ]);
    expect(r.status).toBe("diagnostic");
    if (r.status !== "diagnostic") return;
    expect(r.equalWeight.entries[0].qty).toBe(9);
    expect(r.equalRisk.entries[0].qty).toBe(10);
    expect(r.equalWeight.finalNav).toBe(10140);
    expect(r.equalWeight.cash).toBe(10140);
  });

  it.each([
    { stop: null }, { stop: 0 }, { stop: 100 }, { entryStopVerified: false },
    { stopObservedAt: "2026-09-18T15:00:00Z" }, { tainted: true },
  ])("refuses corrupt/future entry risk evidence %j without returning one favorable arm", (change) => {
    const r = replayPortfolioSizing(plan, [{ ...entry, ...change } as SizingTapeEvent, marks]);
    expect(r.status).toBe("invalid");
    expect(r.equalWeight).toBeNull();
    expect(r.equalRisk).toBeNull();
  });

  it("does not borrow a future mark to size a second entry", () => {
    const tomorrow = { ...entry, id: "b", entryId: "b", symbol: "BBB", at: "2026-09-20T14:00:00Z" };
    const r = replayPortfolioSizing({ ...plan, endAt: tomorrow.at }, [entry, tomorrow,
      { ...marks, at: tomorrow.at, prices: { AAA: 110, BBB: 100 } }]);
    expect(r.status).toBe("invalid");
    if (r.status === "invalid") expect(r.reason).toMatch(/stale mark/);
  });

  it("rejects over-selling, unordered data, unknown events and duplicate IDs", () => {
    const sale: SizingTapeEvent = { id: "sell", kind: "exit", entryId: "a", at: plan.endAt, price: 110, originalFraction: 1 };
    for (const tape of [[sale, entry], [entry, sale, { ...sale, id: "again" }], [entry, entry],
      [entry, { id: "bad", at: plan.endAt, kind: "deposit" } as unknown as SizingTapeEvent]]) {
      expect(replayPortfolioSizing(plan, tape).status).toBe("invalid");
    }
  });

  it("does not let this experiment turn into top-ups", () => {
    expect(replayPortfolioSizing(plan, [entry, { ...entry, id: "add", entryId: "add" }]).status).toBe("invalid");
  });

  it("a cash shortage cannot be hidden by allocating independent full portfolios", () => {
    const tape: SizingTapeEvent[] = Array.from({ length: 15 }, (_, i) => ({ ...entry, id: `buy${i}`, entryId: `${i}`, symbol: `S${i}`, sector: `sector${i}` }));
    tape.push({ ...marks, prices: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`S${i}`, 100])) });
    const r = replayPortfolioSizing({ ...plan, maxGrossPct: 100, maxNamePct: 100, maxSectorPct: 100 }, tape);
    expect(r.status).toBe("diagnostic");
    if (r.status !== "diagnostic") return;
    expect(r.equalWeight.cash).toBeCloseTo(0);
    expect(r.equalRisk.cash).toBeCloseTo(0);
    expect(r.equalWeight.entries.filter(e => e.qty === 0)).toHaveLength(2);
    expect(r.equalRisk.entries.filter(e => e.qty === 0)).toHaveLength(5);
  });

  it("is deterministic and does not change input data", () => {
    const tape = [entry, marks];
    const before = JSON.stringify({ plan, tape });
    expect(replayPortfolioSizing(plan, tape)).toEqual(replayPortfolioSizing(plan, tape));
    expect(JSON.stringify({ plan, tape })).toBe(before);
  });
});
