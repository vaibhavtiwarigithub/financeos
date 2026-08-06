import { describe, it, expect } from "vitest";
import {
  benchmarkReturnBetween,
  evaluatePathGeometry,
  buildPathCandidates,
  hasRequiredFutureSessions,
  simulateExit,
  type PathGeometry,
  type SimBar,
} from "@/lib/trading/exit-path-sim";

function bar(close: number, high = close, low = close, date = "2026-07-06"): SimBar {
  return { date, high, low, close };
}

const FLAT: PathGeometry = { stopPct: 0.075, targetPct: 0.192, maxSessions: 10 };

describe("simulateExit — entry bar and ordering", () => {
  it("never exits on the entry bar, whose range is already past at our fill", () => {
    // Entry bar dips 20% intraday. We entered at its CLOSE, so that low is
    // behind us and must not trigger a stop.
    const bars = [bar(100, 101, 80), bar(101, 102, 100)];
    const exit = simulateExit(bars, FLAT);
    expect(exit.reason).toBe("time");
    expect(exit.sessions).toBe(1);
  });

  it("takes the STOP on a bar that touches both levels (pessimistic)", () => {
    // Assuming the favourable branch here is how a backtest invents an edge.
    const bars = [bar(100), { date: "d1", high: 125, low: 90, close: 100 }];
    const exit = simulateExit(bars, FLAT);
    expect(exit.reason).toBe("stop");
    expect(exit.ret).toBeCloseTo(-0.075);
    expect(exit.intrabarAmbiguous).toBe(true);
  });

  it("books the target when the stop was never breached", () => {
    const bars = [bar(100), { date: "d1", high: 125, low: 99, close: 120 }];
    const exit = simulateExit(bars, FLAT);
    expect(exit.reason).toBe("target");
    expect(exit.ret).toBeCloseTo(0.192);
    expect(exit.intrabarAmbiguous).toBe(false);
  });

  it("falls through to the time stop at maxSessions, booking the close", () => {
    const bars = [bar(100), bar(101), bar(102), bar(103)];
    const exit = simulateExit(bars, { ...FLAT, maxSessions: 2 });
    expect(exit.reason).toBe("time");
    expect(exit.sessions).toBe(2);
    expect(exit.ret).toBeCloseTo(0.02); // bars[2].close, not bars[3]
  });

  it("is unresolved rather than wrong on unusable input", () => {
    expect(simulateExit([bar(100)], FLAT).reason).toBe("unresolved");
    expect(simulateExit([], FLAT).reason).toBe("unresolved");
    expect(simulateExit([bar(0), bar(1)], FLAT).reason).toBe("unresolved");
  });
});

describe("simulateExit — the trailing stop", () => {
  const TRAIL: PathGeometry = { stopPct: 0.075, trailPct: 0.025, maxSessions: 10 };

  it("captures a gain that the live 7.5% trail would have given back entirely", () => {
    // Runs to +4%, then round-trips to flat. This is the measured modal case:
    // 53-63% of profitable positions surrendered 70%+ of their move.
    const path = [bar(100), bar(104, 104, 100), bar(100, 100, 99)];
    const tight = simulateExit(path, TRAIL);
    expect(tight.reason).toBe("trail");
    expect(tight.ret).toBeGreaterThan(0); // banked near the high

    const live = simulateExit(path, { stopPct: 0.075, trailPct: 0.075, maxSessions: 10 });
    expect(live.reason).toBe("time");
    expect(live.ret).toBeCloseTo(0); // gave it all back — a 7.5% trail never engaged
  });

  it("computes the trail from the high BEFORE the current bar", () => {
    // Without this, a bar could ratchet the stop up on its own high and then be
    // stopped out by its own low — a look-ahead inside one session.
    const bars = [bar(100), { date: "d1", high: 110, low: 106, close: 108 }];
    // Trail from the ENTRY bar's high (100) is 97.5, and the low of 106 is well
    // above it, so no exit. Trailing from THIS bar's high (110 -> 107.25) would
    // have wrongly stopped at 106.
    expect(simulateExit(bars, TRAIL).reason).toBe("time");
  });

  it("ratchets one way — the trail never loosens as price falls", () => {
    const bars = [bar(100), bar(110, 110, 100), bar(105, 106, 104), bar(103, 104, 102)];
    const exit = simulateExit(bars, TRAIL);
    // High of 110 sets the trail at 107.25 and it stays there; bar 2's low of
    // 104 breaches it.
    expect(exit.reason).toBe("trail");
    expect(exit.sessions).toBe(2);
    expect(exit.ret).toBeCloseTo(0.0725);
  });

  it("a trail TIGHTER than the initial stop binds from the very first bar", () => {
    // The trail anchors on the entry bar's high, so a 2.5% trail sits at 97.5
    // while the initial stop is at 92.5 — the trail is what actually fires, even
    // on a position that never rose. This is correct: a trailing stop is by
    // definition never further than its distance from the running high.
    const bars = [bar(100), bar(95, 100, 92)];
    const exit = simulateExit(bars, TRAIL);
    expect(exit.reason).toBe("trail");
    expect(exit.ret).toBeCloseTo(-0.025); // not the -7.5% initial stop
  });

  it("reports `stop` when the initial stop is the tighter of the two", () => {
    // Trail 10% is looser than the 7.5% initial stop, so the initial stop binds.
    const bars = [bar(100), bar(95, 100, 92)];
    const exit = simulateExit(bars, { stopPct: 0.075, trailPct: 0.10, maxSessions: 10 });
    expect(exit.reason).toBe("stop");
    expect(exit.ret).toBeCloseTo(-0.075);
  });
});

describe("evaluatePathGeometry", () => {
  it("aggregates outcomes and excludes unresolved paths from the mean", () => {
    const paths = [
      [bar(100), bar(120, 125, 99)],   // target +0.192
      [bar(100)],                       // unresolved
    ];
    const r = evaluatePathGeometry(paths, FLAT, "t");
    expect(r.n).toBe(2);
    expect(r.unresolved).toBe(1);
    expect(r.target).toBe(1);
    expect(r.meanReturn).toBeCloseTo(0.192);
  });

  it("counts intra-bar ambiguity so the pessimistic assumption stays visible", () => {
    const r = evaluatePathGeometry([[bar(100), { date: "d", high: 125, low: 90, close: 100 }]], FLAT, "t");
    expect(r.intrabarAmbiguous).toBe(1);
    expect(r.stop).toBe(1);
  });
});

describe("candidate set", () => {
  it("binds the incumbent to the supplied market mandate", () => {
    const candidates = buildPathCandidates({ stopPct: 0.07, targetPct: 0.20, maxSessions: 10 });
    expect(candidates[0].baseline).toBe(true);
    expect(candidates[0].geometry).toMatchObject({
      stopPct: 0.07, targetPct: 0.20, trailPct: 0.07, maxSessions: 10,
    });
    expect(candidates[0].label).toContain("MANDATE PROXY");
    expect(candidates.filter((c) => c.baseline)).toHaveLength(1);
  });

  it("includes a no-trail arm so the trail's effect is isolable", () => {
    const candidates = buildPathCandidates({ stopPct: 0.07, targetPct: 0.20, maxSessions: 10 });
    expect(candidates.some((c) => c.geometry.trailPct == null)).toBe(true);
  });

  it("varies the clock, since the horizon is itself in question", () => {
    const candidates = buildPathCandidates({ stopPct: 0.07, targetPct: 0.20, maxSessions: 10 });
    expect(new Set(candidates.map((c) => c.geometry.maxSessions)).size).toBeGreaterThan(1);
  });
});

describe("counterfactual maturity", () => {
  it("refuses a path that cannot complete the longest candidate clock", () => {
    expect(hasRequiredFutureSessions([bar(100), bar(101)], 20)).toBe(false);
    expect(hasRequiredFutureSessions(Array.from({ length: 21 }, () => bar(100)), 20)).toBe(true);
  });
});

describe("benchmark leg", () => {
  const bench = new Map<string, number>([
    ["2026-07-06", 100],
    ["2026-07-07", 102],
    ["2026-07-08", 104],
  ]);

  it("matches by DATE, never by index", () => {
    // Subject and benchmark have different holiday calendars. A positional join
    // would compare 07-06 against 07-08 and invent a return.
    expect(benchmarkReturnBetween(bench, "2026-07-06", "2026-07-07")).toBeCloseTo(0.02);
    expect(benchmarkReturnBetween(bench, "2026-07-06", "2026-07-08")).toBeCloseTo(0.04);
  });

  it("returns null on an unmatched or unusable date rather than guessing", () => {
    expect(benchmarkReturnBetween(bench, "2026-07-06", "2026-07-09")).toBeNull();
    expect(benchmarkReturnBetween(bench, null, "2026-07-08")).toBeNull();
    expect(benchmarkReturnBetween(new Map([["a", 0]]), "a", "a")).toBeNull();
  });

  it("charges each rule only for the benchmark exposure it actually held", () => {
    // Subject rises 2% over one session while the benchmark rises 2% too:
    // excess is zero, even though the raw return looks positive.
    const paths = [[bar(100, 100, 100, "2026-07-06"), bar(102, 102, 102, "2026-07-07")]];
    const r = evaluatePathGeometry(paths, { stopPct: 0.075, maxSessions: 1 }, "t", false, bench);
    expect(r.meanReturn).toBeCloseTo(0.02);
    expect(r.meanExcess).toBeCloseTo(0);
    expect(r.benchmarkUnmatched).toBe(0);
  });

  it("counts unmatched benchmark legs instead of dropping them silently", () => {
    const paths = [[bar(100, 100, 100, "1999-01-01"), bar(102, 102, 102, "1999-01-02")]];
    const r = evaluatePathGeometry(paths, { stopPct: 0.075, maxSessions: 1 }, "t", false, bench);
    expect(r.benchmarkUnmatched).toBe(1);
    expect(r.meanExcess).toBeNull();
    expect(r.meanReturn).toBeCloseTo(0.02); // the raw leg still stands
  });

  it("reports null excess when no benchmark is supplied", () => {
    const paths = [[bar(100, 100, 100, "2026-07-06"), bar(102, 102, 102, "2026-07-07")]];
    const r = evaluatePathGeometry(paths, { stopPct: 0.075, maxSessions: 1 }, "t");
    expect(r.meanExcess).toBeNull();
    expect(r.excessWinRate).toBeNull();
  });
});
