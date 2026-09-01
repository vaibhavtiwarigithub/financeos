import { describe, it, expect } from "vitest";
import { specFingerprint, validateSpec, type RuleSpec } from "@/lib/strategy-replay/rule-spec";
import { compileSpec, evaluate, type Bar } from "@/lib/strategy-replay/compile";
import { markNavSeries, type DailyMark, type HoldingsAt } from "@/lib/strategy-replay/nav-marker";
import { neverTradesControl, alwaysInControl, deterministicCoin } from "@/lib/strategy-replay/negative-control";
import { simulatePortfolio, type SimulationPolicy } from "@/lib/simulation/portfolio-simulator";

const SESSIONS = ["2026-01-05","2026-01-06","2026-01-07","2026-01-08","2026-01-09",
                  "2026-01-12","2026-01-13","2026-01-14","2026-01-15","2026-01-16"];

/** Rising series so direction-sensitive assertions are unambiguous. */
const bars = (start = 100, step = 1): Bar[] =>
  SESSIONS.map((session, i) => ({
    session, open: start + i * step, high: start + i * step + 0.5,
    low: start + i * step - 0.5, close: start + i * step,
  }));

const baseSpec = (over: Partial<RuleSpec> = {}): RuleSpec => ({
  id: "t", label: "t", role: "entry", market: "us", universe: ["AAA"],
  horizonSessions: 3, execution: "next_open", positionSizePct: 0.1,
  entry: { op: "always" }, exit: { op: "never" }, ruleVersion: "v1", ...over,
});

describe("look-ahead guard", () => {
  // The catalogue's own Turnaround Tuesday article admits that entering at the
  // close using that same close is a look-forward execution problem. The spec
  // layer must refuse it rather than produce a flattering number.
  it("refuses a close-derived signal executed at the same close", () => {
    const errs = validateSpec(baseSpec({
      execution: "same_close",
      entry: { op: "cmp", left: { fn: "rsi", period: 2 }, cmp: "<", right: 10 },
    }));
    expect(errs.some((e) => e.includes("look-ahead"))).toBe(true);
  });

  it("accepts the same signal at next_open", () => {
    expect(validateSpec(baseSpec({
      execution: "next_open",
      entry: { op: "cmp", left: { fn: "rsi", period: 2 }, cmp: "<", right: 10 },
    }))).toEqual([]);
  });

  it("fills next_open at the NEXT session's open, never the signal close", () => {
    const series = bars();
    const r = compileSpec({ spec: baseSpec(), bars: { AAA: series }, initialCash: 10000 });
    const first = r.events.find((e) => e.kind === "entry")!;
    expect(first.session).toBe(SESSIONS[1]);
    expect(first.price).toBe(series[1].open);
    expect(first.price).not.toBe(series[0].close);
  });
});

describe("spec fingerprint is the trial identity", () => {
  // The review's point that "Turnaround Tuesday, adapted to next-open" is a NEW
  // specification depends entirely on execution timing being inside the hash.
  it("changes when execution timing changes", () => {
    const a = specFingerprint(baseSpec({ execution: "next_open", entry: { op: "always" } }));
    const b = specFingerprint(baseSpec({ execution: "same_close", entry: { op: "always" } }));
    expect(a).not.toBe(b);
  });

  it("changes when a parameter changes", () => {
    const a = specFingerprint(baseSpec({ entry: { op: "cmp", left: { fn: "rsi", period: 2 }, cmp: "<", right: 10 } }));
    const b = specFingerprint(baseSpec({ entry: { op: "cmp", left: { fn: "rsi", period: 2 }, cmp: "<", right: 15 } }));
    expect(a).not.toBe(b);
  });

  it("changes when the universe changes", () => {
    expect(specFingerprint(baseSpec({ universe: ["AAA"] })))
      .not.toBe(specFingerprint(baseSpec({ universe: ["AAA", "BBB"] })));
  });

  it("is stable under universe ORDER and is 64 hex", () => {
    const a = specFingerprint(baseSpec({ universe: ["AAA", "BBB"] }));
    const b = specFingerprint(baseSpec({ universe: ["BBB", "AAA"] }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("warm-up is undecidable, not false", () => {
  // Treating an unavailable indicator as `false` silently converts "we cannot
  // know" into "do not trade", which biases every warm-up window.
  it("returns null before the indicator has enough history", () => {
    const series = bars();
    expect(evaluate({ op: "cmp", left: { fn: "sma", period: 5 }, cmp: ">", right: 0 },
      { bars: series, idx: 1 })).toBeNull();
    expect(evaluate({ op: "cmp", left: { fn: "sma", period: 5 }, cmp: ">", right: 0 },
      { bars: series, idx: 6 })).toBe(true);
  });

  it("counts warm-up sessions instead of trading through them", () => {
    const r = compileSpec({
      spec: baseSpec({ entry: { op: "cmp", left: { fn: "sma", period: 5 }, cmp: ">", right: 0 } }),
      bars: { AAA: bars() }, initialCash: 10000,
    });
    // sma(5) is undecidable for the first 4 of 10 bars.
    expect(r.warmupSkipped).toBe(4);
    // EXACT, because this is the assertion that catches the real defect: a
    // warm-up session must never also be counted as a DECISION session.
    // Measured both ways — correct code yields 2 (the rule holds a position
    // through most decidable sessions); dropping the `continue` yields 6,
    // silently inflating the sample by every warm-up bar. Any evidence floor
    // computed from decisionSessions would then pass on data that does not
    // exist, which is precisely how a too-small sample looks large enough.
    expect(r.decisionSessions).toBe(2);
  });

  it("short-circuits AND on a false term even when another is undecidable", () => {
    const series = bars();
    const p = { op: "and" as const, terms: [
      { op: "never" as const },
      { op: "cmp" as const, left: { fn: "sma" as const, period: 9 }, cmp: ">" as const, right: 0 },
    ]};
    expect(evaluate(p, { bars: series, idx: 1 })).toBe(false);
  });
});

describe("forced horizon exit", () => {
  it("closes at horizonSessions even when the exit predicate never fires", () => {
    const r = compileSpec({
      spec: baseSpec({ horizonSessions: 3, exit: { op: "never" } }),
      bars: { AAA: bars() }, initialCash: 10000,
    });
    expect(r.events.some((e) => e.kind === "exit")).toBe(true);
  });
});

describe("NAV marker", () => {
  const holdings = (navs: Array<[string, number, number]>): HoldingsAt[] =>
    navs.map(([session, cash, qty]) => ({
      session, cash, positions: qty ? [{ symbol: "AAA", quantity: qty, costBasis: 100 }] : [],
    }));

  it("produces a NAV path, drawdown and excess the simulator cannot", () => {
    const s = markNavSeries(
      holdings([["d1", 0, 10], ["d2", 0, 10], ["d3", 0, 10]]),
      [{ session: "d1", prices: { AAA: 100 }, benchClose: 50 },
       { session: "d2", prices: { AAA: 120 }, benchClose: 55 },
       { session: "d3", prices: { AAA: 110 }, benchClose: 60 }] as DailyMark[],
    );
    expect(s.points).toHaveLength(3);
    expect(s.totalReturnPct).toBeCloseTo(10, 6);        // 1000 -> 1100
    expect(s.benchTotalReturnPct).toBeCloseTo(20, 6);   // 50 -> 60
    expect(s.netExcessReturnPp).toBeCloseTo(-10, 6);
    expect(s.maxDrawdownPct).toBeCloseTo(100 * (1200 - 1100) / 1200, 4);
  });

  // A missing quote is missing information, not a wipeout.
  it("carries an unpriced holding at cost and counts the session", () => {
    const s = markNavSeries(
      holdings([["d1", 0, 10], ["d2", 0, 10]]),
      [{ session: "d1", prices: { AAA: 100 }, benchClose: null },
       { session: "d2", prices: {}, benchClose: null }] as DailyMark[],
    );
    expect(s.points[1].nav).toBeCloseTo(1000, 6);
    expect(s.unpricedSessions).toBe(1);
  });

  it("returns null rather than inventing an excess when the benchmark is absent", () => {
    const s = markNavSeries(
      holdings([["d1", 1000, 0], ["d2", 1000, 0]]),
      [{ session: "d1", prices: {}, benchClose: null },
       { session: "d2", prices: {}, benchClose: null }] as DailyMark[],
    );
    expect(s.benchTotalReturnPct).toBeNull();
    expect(s.netExcessReturnPp).toBeNull();
  });

  it("reports null Sharpe on zero variance instead of infinite skill", () => {
    const s = markNavSeries(
      holdings([["d1", 1000, 0], ["d2", 1000, 0], ["d3", 1000, 0]]),
      [{ session: "d1", prices: {}, benchClose: 10 },
       { session: "d2", prices: {}, benchClose: 10 },
       { session: "d3", prices: {}, benchClose: 10 }] as DailyMark[],
    );
    expect(s.sharpe).toBeNull();
    expect(s.sortino).toBeNull();
  });
});

describe("negative controls", () => {
  // THE POINT OF STEP 3: if a rule that cannot have an edge scores one, the seam
  // is wrong and no real strategy measured through it can be believed.
  it("never-trades control emits no events and a flat NAV", () => {
    const r = compileSpec({
      spec: neverTradesControl("us", ["AAA"]), bars: { AAA: bars() }, initialCash: 10000,
    });
    expect(r.events).toHaveLength(0);

    const s = markNavSeries(
      SESSIONS.map((session) => ({ session, cash: 10000, positions: [] })),
      SESSIONS.map((session) => ({ session, prices: {}, benchClose: null })),
    );
    expect(s.totalReturnPct).toBe(0);
    expect(s.maxDrawdownPct).toBe(0);
    expect(s.sharpe).toBeNull();
  });

  it("always-in control does trade, so the seam is not simply inert", () => {
    const r = compileSpec({
      spec: alwaysInControl("us", ["AAA"]), bars: { AAA: bars() }, initialCash: 10000,
    });
    expect(r.events.filter((e) => e.kind === "entry").length).toBeGreaterThan(0);
  });

  it("coin control is deterministic across runs", () => {
    const a = SESSIONS.map((s) => deterministicCoin(s, "control"));
    const b = SESSIONS.map((s) => deterministicCoin(s, "control"));
    expect(a).toEqual(b);
    // A different salt must give a different sequence, or it is not a coin.
    expect(SESSIONS.map((s) => deterministicCoin(s, "other"))).not.toEqual(a);
  });
});

describe("compiled events survive the SIMULATOR, not just the compiler", () => {
  // THE GAP THIS CLOSES (found 2026-09-01 by running on real VOO bars).
  // Every test above counted EVENTS. None put them through the simulator, so
  // nobody noticed the compiler emitted exits with no `quantity` — which
  // portfolio-simulator.ts:136 rejects as `invalid_exit`. Positions never
  // closed, and on 1,280 real bars the rule produced 1 fill and 96 rejections.
  // Counting events is not evidence that the events are executable.
  const policy: SimulationPolicy = {
    market: "us", currency: "USD", initialCash: 100_000,
    maxOpenNames: 1, allowFractionalShares: true,
  };

  it("produces fills, not rejections, for a rule that round-trips", () => {
    const r = compileSpec({
      spec: baseSpec({ horizonSessions: 2, exit: { op: "never" } }),
      bars: { AAA: bars() }, initialCash: 100_000,
    });
    const sim = simulatePortfolio(policy, r.events);
    expect(r.events.length).toBeGreaterThan(2);
    expect(sim.rejections).toHaveLength(0);
    expect(sim.fills.length).toBe(r.events.length);
  });

  it("emits an explicit exit quantity matching the entry fill", () => {
    const r = compileSpec({
      spec: baseSpec({ horizonSessions: 2, exit: { op: "never" } }),
      bars: { AAA: bars() }, initialCash: 100_000,
    });
    const exits = r.events.filter((e) => e.kind === "exit");
    expect(exits.length).toBeGreaterThan(0);
    for (const e of exits) {
      expect(e.quantity).toBeDefined();
      expect(e.quantity!).toBeGreaterThan(0);
    }
    const sim = simulatePortfolio(policy, r.events);
    expect(sim.rejections.filter((x) => x.reason === "invalid_exit")).toHaveLength(0);
  });

  it("closes every position it opens, leaving no dangling lot", () => {
    const r = compileSpec({
      spec: baseSpec({ horizonSessions: 2, exit: { op: "never" } }),
      bars: { AAA: bars() }, initialCash: 100_000,
    });
    const sim = simulatePortfolio(policy, r.events);
    const entries = sim.fills.filter((f) => f.kind === "entry").length;
    const exits = sim.fills.filter((f) => f.kind === "exit").length;
    // Either fully paired, or one lot still open at the end of the series.
    expect(entries - exits).toBeLessThanOrEqual(1);
    expect(sim.positions.length).toBeLessThanOrEqual(1);
  });
});

describe("allocation tracks available cash, not initial cash", () => {
  // THE DEFECT (found on real VOO bars, 2026-09-01): cashAllocation was pinned
  // to INITIAL cash while real cash drifted, so at positionSizePct = 1.0 a
  // single losing round trip made every later entry unaffordable. 93 of 97
  // events were rejected as insufficient_cash.
  const policy: SimulationPolicy = {
    market: "us", currency: "USD", initialCash: 100_000,
    maxOpenNames: 1, allowFractionalShares: true,
  };

  /** Falling series, so every round trip realises a loss and cash shrinks. */
  const falling = (): Bar[] =>
    SESSIONS.map((session, i) => ({
      session, open: 100 - i, high: 100 - i + 0.2, low: 100 - i - 0.2, close: 100 - i,
    }));

  it("stays fully invested at positionSizePct 1.0 even after losses", () => {
    const r = compileSpec({
      spec: baseSpec({ positionSizePct: 1.0, horizonSessions: 2, exit: { op: "never" } }),
      bars: { AAA: falling() }, initialCash: 100_000,
    });
    const sim = simulatePortfolio(policy, r.events);
    expect(r.events.length).toBeGreaterThan(2);
    // The whole point: no insufficient_cash rejections despite realised losses.
    expect(sim.rejections.filter(x => x.reason === "insufficient_cash")).toHaveLength(0);
    expect(sim.rejections).toHaveLength(0);
  });

  it("shrinks the allocation as capital shrinks", () => {
    const r = compileSpec({
      spec: baseSpec({ positionSizePct: 1.0, horizonSessions: 2, exit: { op: "never" } }),
      bars: { AAA: falling() }, initialCash: 100_000,
    });
    const allocations = r.events
      .filter(e => e.kind === "entry")
      .map(e => e.cashAllocation!);
    expect(allocations.length).toBeGreaterThan(1);
    // Each successive entry commits less than the last, because the book lost.
    for (let i = 1; i < allocations.length; i++) {
      expect(allocations[i]).toBeLessThan(allocations[0]);
    }
  });

  it("the always-in control is actually fully invested", () => {
    const spec = alwaysInControl("us", ["AAA"]);
    expect(spec.positionSizePct).toBe(1);
    const r = compileSpec({ spec, bars: { AAA: bars() }, initialCash: 100_000 });
    const sim = simulatePortfolio(policy, r.events);
    expect(sim.rejections).toHaveLength(0);
    expect(r.events.filter(e => e.kind === "entry").length).toBeGreaterThan(0);
  });
});
