import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideExitLadder, trailAnchorPct, type ExitLadderInput } from "@/lib/trading/exit-ladder";
import { paperPartialTargetQuantity, paperRunnerStopPrice } from "@/lib/trading/paper-quantity";

// THE DEFECT THIS GUARDS.
//
// Paper (position-monitor) banked half at target and trailed a stop behind the
// runner. Live (live-exit-monitor) closed the whole position at target and
// never moved its stop off the entry-day level. Same nominal policy, two
// implementations, materially different outcomes — a live winner banked less
// and a live runner rode an un-trailed stop indefinitely.
//
// decideExitLadder is now the ONE implementation both call. These tests pin
// the behaviors that were previously live-only bugs, plus the price paths the
// architecture doc named as the parity acceptance bar.

const base: ExitLadderInput = {
  market: "us",
  qty: 100,
  avgEntry: 100,
  price: 100,
  priceTarget: 110,
  initialStopLoss: 93,
  currentStop: 93,
  highestPrice: 100,
  partialTaken: false,
};

describe("shared-core wiring", () => {
  it("paper and live monitors both call the same ladder decision function", () => {
    const paper = readFileSync(join(process.cwd(), "app/api/agents/position-monitor/route.ts"), "utf8");
    const live = readFileSync(join(process.cwd(), "lib/trading/live-exit-monitor.ts"), "utf8");
    expect(paper).toContain("decideExitLadder({");
    expect(live).toContain("decideExitLadder({");
  });
});

describe("trailAnchorPct — the trail rides the position's OWN stop distance", () => {
  it("a wide initial stop keeps a wide trail", () => {
    expect(trailAnchorPct(88, 100)).toBeCloseTo(0.88, 5);
  });
  it("a tight initial stop keeps a tight trail", () => {
    expect(trailAnchorPct(96, 100)).toBeCloseTo(0.96, 5);
  });
  it("falls back to 0.93 when there is no initial stop to derive from", () => {
    expect(trailAnchorPct(null, 100)).toBe(0.93);
  });
  it("clamps a nonsense anchor rather than trusting it", () => {
    expect(trailAnchorPct(10, 100)).toBe(0.5);   // absurdly wide
    expect(trailAnchorPct(200, 100)).toBe(0.99); // above entry
  });
});

describe("the trail ratchets and never loosens", () => {
  // Target raised out of the way so these isolate the trail itself — with the
  // default 110 target these prices would (correctly) take the partial first.
  const noTarget = { ...base, priceTarget: 200 };

  it("raises the stop as the high-water mark rises", () => {
    const d = decideExitLadder({ ...noTarget, price: 120, highestPrice: 120 });
    expect(d.trailingStop).toBeCloseTo(120 * 0.93, 5);
    expect(d.action).toBe("none");
  });

  it("does NOT lower the stop when price falls back from the high", () => {
    // High was 120 (stop 111.6). Price drops to 112 — above the trail, so no
    // exit, and the stop must stay where it ratcheted to.
    const d = decideExitLadder({ ...noTarget, price: 112, highestPrice: 120, currentStop: 111.6 });
    expect(d.trailingStop).toBeCloseTo(111.6, 5);
    expect(d.action).toBe("none");
  });

  it("persists the high-water mark even on a no-action run", () => {
    const d = decideExitLadder({ ...base, price: 105, highestPrice: 100 });
    expect(d.highestPrice).toBe(105);
  });
});

describe("partial target — the behavior live never had", () => {
  it("supports a fractional US holding rather than silently skipping it", () => {
    const d = decideExitLadder({ ...base, qty: 0.75, price: 111 });
    expect(d.action).toBe("partial_target");
    expect(d.exitQty).toBeCloseTo(0.375, 8);
  });

  it("banks half and protects the runner at breakeven-or-better", () => {
    const d = decideExitLadder({ ...base, price: 111 });
    expect(d.action).toBe("partial_target");
    expect(d.exitQty).toBe(paperPartialTargetQuantity("us", 100));
    expect(d.runnerStop).toBe(paperRunnerStopPrice(100, d.trailingStop));
    expect(d.runnerStop!).toBeGreaterThanOrEqual(base.avgEntry); // never below breakeven
    expect(d.outcome).toBe("win");
  });

  it("does NOT re-fire once the partial is taken — this is the bleed guard", () => {
    const d = decideExitLadder({ ...base, price: 115, partialTaken: true });
    expect(d.action).toBe("runner_hold");
    expect(d.exitQty).toBeUndefined();
  });

  it("closes fully when the position is too small to split", () => {
    const d = decideExitLadder({ ...base, market: "india", qty: 1, price: 111 });
    expect(d.action).toBe("target_full");
    expect(d.exitQty).toBe(1);
  });

  it("never takes partial profit on a hedge", () => {
    const d = decideExitLadder({ ...base, price: 111, isHedge: true });
    expect(d.action).not.toBe("partial_target");
  });
});

describe("exit precedence — stop beats target", () => {
  it("does not use today's close to create a stop against today's earlier low", () => {
    const d = decideExitLadder({
      ...base,
      price: 120,
      stopCheckPrice: 94,
      highestPrice: 100,
      currentStop: 93,
      priceTarget: null,
    });
    expect(d.action).toBe("none");
    expect(d.trailingStop).toBeCloseTo(111.6, 5);
    expect(d.highestPrice).toBe(120);
  });

  it("a bar that breaches the stop AND touches the target exits protectively", () => {
    // Honest assumption: if both were touched intrabar, assume the bad one.
    const d = decideExitLadder({ ...base, price: 111, stopCheckPrice: 92 });
    expect(d.action).toBe("stop_full");
  });

  // NO TIME STOP. Removed 2026-09-10 by owner decision, superseding Decision 65.
  // A clock is not a reason to exit. Over 203 closed paper lots the horizon did
  // 140 of the exits while the score exit did ZERO, so the calendar — not the
  // research — was the real policy, and in India it was cutting winners short.
  it("holds a position that is merely OLD — age is not an exit", () => {
    const d = decideExitLadder({ ...base, price: 101 });
    expect(d.action).toBe("none");
    expect(d.exitQty).toBeUndefined();
  });

  it("an old position still exits on its trail, not on its age", () => {
    const d = decideExitLadder({ ...base, price: 92, stopCheckPrice: 92 });
    expect(d.action).toBe("stop_full");
  });
});

describe("stop labelling distinguishes an intraday touch from a close", () => {
  it("marks an intraday touch that recovered by close", () => {
    const d = decideExitLadder({ ...base, price: 100, stopCheckPrice: 92 });
    expect(d.action).toBe("stop_full");
    expect(d.reason).toContain("intraday");
  });

  it("a stop above entry is a win, below is a loss", () => {
    const win = decideExitLadder({ ...base, price: 112, highestPrice: 130, currentStop: 120, stopCheckPrice: 119 });
    expect(win.outcome).toBe("win");
    const loss = decideExitLadder({ ...base, price: 90, stopCheckPrice: 90 });
    expect(loss.outcome).toBe("loss");
  });
});

// The price paths the architecture doc named as the acceptance bar. Each is
// driven bar-by-bar through the single engine, carrying state forward exactly
// as both callers will — proving the sequence, not just one decision.
describe("full price paths", () => {
  function walk(prices: number[], start: Partial<ExitLadderInput> = {}) {
    let state = { ...base, ...start };
    const actions: string[] = [];
    for (const price of prices) {
      const d = decideExitLadder({ ...state, price });
      actions.push(d.action);
      if (d.action === "stop_full" || d.action === "target_full") break;
      state = {
        ...state,
        price,
        highestPrice: d.highestPrice,
        currentStop: d.action === "partial_target" ? d.runnerStop! : d.trailingStop,
        qty: d.action === "partial_target" ? state.qty - d.exitQty! : state.qty,
        partialTaken: state.partialTaken || d.action === "partial_target",
      };
    }
    return actions;
  }

  it("runner: target, then rides the trail, then stops out in profit", () => {
    const actions = walk([105, 111, 125, 140, 120]);
    expect(actions).toEqual(["none", "partial_target", "runner_hold", "runner_hold", "stop_full"]);
  });

  it("target then immediate reverse: banks the partial, runner stops at breakeven-or-better", () => {
    const actions = walk([111, 95]);
    expect(actions[0]).toBe("partial_target");
    expect(actions[1]).toBe("stop_full"); // runner stop was raised to >= entry
  });

  it("straight stop-out never reaches the target branch", () => {
    expect(walk([98, 95, 92])).toEqual(["none", "none", "stop_full"]);
  });

  it("chop below target: no action, no partial, stop only ratchets", () => {
    expect(walk([102, 105, 103, 106])).toEqual(["none", "none", "none", "none"]);
  });
});
