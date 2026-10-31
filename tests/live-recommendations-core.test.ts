import { describe, expect, it } from "vitest";
import { atr14, classifyResponse, evaluateArms, holdingChange, markRecommendation, revisionNote, simulateArm, type Bar, type Snap } from "@/lib/live-recommendations/core";
import { displayedRecommendationPnl, hypotheticalReductionImpact, parseExitTriggerLevels } from "@/lib/live-recommendations/display";

const bar = (date: string, o: number, h: number, l: number, c: number): Bar => ({ date, open: o, high: h, low: l, close: c });
const snap = (date: string, qty: number, accountId = "A"): Snap => ({ date, qty, avgCost: 10, accountId });

describe("holdingChange", () => {
  it("uses the pre-issue snapshot as baseline", () => {
    expect(holdingChange([snap("2026-10-01", 5), snap("2026-10-03", 8)], "2026-10-02")).toEqual({ account: "A", delta: 3 });
  });
  it("does not mistake a pre-existing position for a purchase when no pre-issue snapshot exists", () => {
    expect(holdingChange([snap("2026-10-05", 5), snap("2026-10-06", 5)], "2026-10-02")?.delta).toBe(0);
  });
  it("detects a sale", () => {
    expect(holdingChange([snap("2026-10-01", 5), snap("2026-10-03", 2)], "2026-10-02")?.delta).toBe(-3);
  });
});

describe("classifyResponse", () => {
  const base = { kind: "buy_idea" as const, issuedDate: "2026-10-02", horizonSessions: 10, sessionsSince: 3, qtySuggested: 1, snaps: [] as Snap[] };
  it("filled proposal is taken", () => expect(classifyResponse({ ...base, proposalStatus: "filled" }).status).toBe("taken"));
  it("holdings increase is taken", () => expect(classifyResponse({ ...base, proposalStatus: "pending_review", approvalExpired: true, snaps: [snap("2026-10-01", 0), snap("2026-10-04", 2)] }).status).toBe("taken"));
  it("a tiny share-count rise worth under $10 is drift, not a purchase", () => expect(classifyResponse({ ...base, referencePrice: 100, proposalStatus: "pending_review", approvalExpired: true, snaps: [snap("2026-10-01", 3), snap("2026-10-04", 3.05)] }).status).toBe("expired_unanswered"));
  it("a proposal swept to expired status also reads as no decision", () => expect(classifyResponse({ ...base, proposalStatus: "expired" }).status).toBe("expired_unanswered"));
  it("expired proposal with no purchase is expired_unanswered", () => expect(classifyResponse({ ...base, proposalStatus: "pending_review", approvalExpired: true }).status).toBe("expired_unanswered"));
  it("stop reached and position cut is followed, not cut is ignored", () => {
    const k = { ...base, kind: "guardian_stop" as const, levelTouched: true };
    expect(classifyResponse({ ...k, snaps: [snap("2026-10-01", 4), snap("2026-10-04", 1)] }).status).toBe("followed");
    expect(classifyResponse({ ...k, snaps: [snap("2026-10-01", 4), snap("2026-10-04", 4)] }).status).toBe("ignored");
    expect(classifyResponse({ ...k, levelTouched: false }).status).toBe("watching");
  });
});

describe("markRecommendation", () => {
  const bars = [bar("2026-10-02", 100, 101, 99, 100), bar("2026-10-03", 100, 103, 95, 102), bar("2026-10-04", 102, 106, 101, 105)];
  const spy = [bar("2026-10-02", 1, 1, 1, 400), bar("2026-10-04", 1, 1, 1, 404)];
  it("computes symbol, benchmark and excess return from the issue close", () => {
    const m = markRecommendation({ kind: "buy_idea", issuedDate: "2026-10-02", referencePrice: 100, levelPrice: null, bars, spyBars: spy });
    expect(m.symbolReturnPct).toBe(5); expect(m.benchmarkReturnPct).toBe(1); expect(m.excessPct).toBe(4); expect(m.pnlBasis).toBe("hypothetical"); expect(m.sessionsSince).toBe(2);
  });
  it("labels actual P/L from average cost when held", () => {
    const m = markRecommendation({ kind: "buy_idea", issuedDate: "2026-10-02", referencePrice: 100, levelPrice: null, bars, spyBars: spy, held: { avgCost: 90, qty: 1 } });
    expect(m.pnlBasis).toBe("actual"); expect(m.pnlPct).toBeCloseTo(16.6667, 3);
  });
  it("detects a stop touch from the session low", () => {
    const m = markRecommendation({ kind: "guardian_stop", issuedDate: "2026-10-02", referencePrice: 100, levelPrice: 96, bars, spyBars: spy });
    expect(m.levelTouched).toBe(true); expect(m.levelTouchedOn).toBe("2026-10-03"); expect(m.pnlIfLevelPct).toBe(-4);
  });
});

describe("hypotheticalReductionImpact", () => {
  it("shows the value protected by a reduction when price falls", () => expect(hypotheticalReductionImpact(4, 100, 90)).toBe(40));
  it("shows foregone upside as a negative impact when price rises", () => expect(hypotheticalReductionImpact(4, 100, 110)).toBe(-40));
  it("does not invent a dollar impact when quantity or a valid price is missing", () => {
    expect(hypotheticalReductionImpact(null, 100, 90)).toBeNull();
    expect(hypotheticalReductionImpact(4, 0, 90)).toBeNull();
  });
});

describe("displayedRecommendationPnl", () => {
  it("uses the frozen level result for a touched Guardian stop", () => {
    expect(displayedRecommendationPnl({ kind: "guardian_stop", pnlPct: -12, levelTouched: true, pnlIfLevelPct: -7 })).toBe(-7);
  });
  it("uses current P/L for untouched stops and other recommendation kinds", () => {
    expect(displayedRecommendationPnl({ kind: "guardian_stop", pnlPct: -4, levelTouched: false, pnlIfLevelPct: null })).toBe(-4);
    expect(displayedRecommendationPnl({ kind: "exit_signal", pnlPct: 3, levelTouched: true, pnlIfLevelPct: -7 })).toBe(3);
  });
});

describe("parseExitTriggerLevels", () => {
  it("extracts the Guardian target and runner stop from the stored shadow rationale", () => {
    expect(parseExitTriggerLevels("partial_target: target: 101.25 >= 100.00 — banking 0.5, runner protected at 98.50"))
      .toEqual({ target: 100, stop: null, runnerStop: 98.5 });
  });
  it("extracts the Guardian stop for regular and intraday stop reasons", () => {
    expect(parseExitTriggerLevels("stop_full: stop hit intraday: 96.25 <= 97.00").stop).toBe(97);
    expect(parseExitTriggerLevels("stop_full: stop: 96.25 <= 97.00 (entry 101.00)").stop).toBe(97);
  });
  it("does not invent levels from unrelated exit reasons", () => {
    expect(parseExitTriggerLevels("score_exit: score below threshold")).toEqual({ target: null, stop: null, runnerStop: null });
  });
});

describe("stop arms", () => {
  const mk = (n: number, f: (i: number) => [number, number, number, number]): Bar[] => Array.from({ length: n }, (_, i) => { const [o, h, l, c] = f(i); return bar(`2026-09-${String(i + 1).padStart(2, "0")}`, o, h, l, c); });
  it("atr needs 15 prior bars", () => {
    expect(atr14(mk(10, () => [10, 11, 9, 10]), "2026-09-30")).toBeNull();
    expect(atr14(mk(20, () => [10, 11, 9, 10]), "2026-09-30")).toBe(2);
  });
  it("exits at the stop when low breaches it, at the open when it gaps through", () => {
    expect(simulateArm("fixed_7", 100, null, [bar("d1", 100, 100, 90, 95), bar("d2", 95, 96, 94, 95)], 2)).toEqual({ retPct: -7, stopped: true });
    expect(simulateArm("fixed_7", 100, null, [bar("d1", 90, 91, 89, 90), bar("d2", 90, 90, 90, 90)], 2)).toEqual({ retPct: -10, stopped: true });
  });
  it("skips arms and unmatured trades it cannot compute", () => {
    expect(simulateArm("atr_2_8", 100, null, [bar("d1", 1, 1, 1, 1)], 1)).toBeNull();
    expect(simulateArm("none", 100, null, [bar("d1", 1, 1, 1, 1)], 2)).toBeNull();
  });
  it("saved vs premature accounting and honest small-sample note", () => {
    const fall = [bar("2026-10-03", 100, 100, 92, 93), bar("2026-10-04", 93, 93, 80, 80)]; // stop saves: -7 vs -20
    const bounce = [bar("2026-10-03", 100, 100, 92, 95), bar("2026-10-04", 95, 110, 95, 110)]; // premature: -7 vs +10
    const ev = evaluateArms([
      { symbol: "A", issuedDate: "2026-10-02", entry: 100, bars: fall }, { symbol: "B", issuedDate: "2026-10-02", entry: 100, bars: bounce },
    ], 2);
    const f7 = ev.arms.find((a) => a.id === "fixed_7")!;
    expect(ev.sample).toBe(2); expect(f7.savedPts).toBe(13); expect(f7.costPts).toBe(17); expect(f7.stoppedShare).toBe(1);
    expect(revisionNote(ev, 2)).toMatch(/Insufficient evidence/);
  });
});
