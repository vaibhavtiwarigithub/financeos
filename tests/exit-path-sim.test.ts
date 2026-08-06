import { describe, it, expect } from "vitest";
import {
  evaluatePathGeometry,
  PATH_CANDIDATES,
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
  it("puts the live rule first, as the incumbent", () => {
    expect(PATH_CANDIDATES[0].baseline).toBe(true);
    expect(PATH_CANDIDATES[0].geometry).toMatchObject({
      stopPct: 0.075, targetPct: 0.192, trailPct: 0.075, maxSessions: 10,
    });
    expect(PATH_CANDIDATES.filter((c) => c.baseline)).toHaveLength(1);
  });

  it("includes a no-trail arm so the trail's effect is isolable", () => {
    expect(PATH_CANDIDATES.some((c) => c.geometry.trailPct == null)).toBe(true);
  });

  it("varies the clock, since the horizon is itself in question", () => {
    expect(new Set(PATH_CANDIDATES.map((c) => c.geometry.maxSessions)).size).toBeGreaterThan(1);
  });
});
