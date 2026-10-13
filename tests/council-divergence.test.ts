import { describe, expect, it } from "vitest";
import { councilBiasByMarket, findCouncilDivergence, type DivergenceRun } from "@/lib/monitoring/council-divergence";

const run = (symbol: string, market: "us" | "india", consensus: number, deterministic: number, over: Partial<DivergenceRun> = {}): DivergenceRun => ({
  market, symbol, decision_ts: "2026-10-13T07:00:00Z", consensus, deterministic, threshold: 60, direction: "long", memberSpread: 5, ...over,
});
const many = (market: "us" | "india", n: number, gap: number) => Array.from({ length: n }, (_, i) => run(`BG${i}`, market, 70 + gap, 70, { decision_ts: "2026-10-12T07:00:00Z" }));

describe("council vs deterministic divergence alert", () => {
  it("measures the gap after removing the market's own offset (India council runs ~12 below the composite)", () => {
    const base = many("india", 40, -12);
    expect(councilBiasByMarket(base).india).toBe(-12);
    const { hits } = findCouncilDivergence({
      runs: [...base, run("TYPICAL.NS", "india", 66, 78), run("OUTLIER.NS", "india", 41, 78)],
      alertWindowStart: "2026-10-13T00:00:00Z", held: new Set(["india:TYPICAL.NS", "india:OUTLIER.NS"]),
    });
    // TYPICAL is 12 below (normal for India): quiet. OUTLIER is 37 below -> 25 after the offset: flagged.
    expect(hits.map((h) => h.symbol)).toEqual(["OUTLIER.NS"]);
    expect(hits[0].adjustedGap).toBe(-25);
    expect(hits[0].reasons[0]).toContain("below the deterministic 78");
  });
  it("uses no offset until the sample is big enough to trust", () => {
    expect(councilBiasByMarket(many("us", 5, -9)).us).toBe(0);
  });
  it("only symbols that are held or entry-eligible can alert", () => {
    const { hits } = findCouncilDivergence({
      runs: [run("HELD", "us", 30, 80), run("ELIGIBLE", "us", 30, 80), run("IRRELEVANT", "us", 30, 80, { direction: "short" }), run("LOWSCORE", "us", 20, 40)],
      alertWindowStart: "2026-10-13T00:00:00Z", held: new Set(["us:HELD"]),
    });
    expect(hits.map((h) => h.symbol).sort()).toEqual(["ELIGIBLE", "HELD"]);
    expect(hits.find((h) => h.symbol === "HELD")).toMatchObject({ held: true });
    expect(hits.find((h) => h.symbol === "ELIGIBLE")).toMatchObject({ entryEligible: true });
  });
  it("flags big member disagreement even when the median agrees with the composite", () => {
    const { hits } = findCouncilDivergence({ runs: [run("SPLIT", "us", 62, 65, { memberSpread: 31 })], alertWindowStart: "2026-10-13T00:00:00Z", held: new Set(["us:SPLIT"]) });
    expect(hits).toHaveLength(1);
    expect(hits[0].reasons).toEqual(["the three members disagree by 31 points"]);
  });
  it("evaluates only the newest run per symbol inside the alert window, largest gap first", () => {
    const { hits } = findCouncilDivergence({
      runs: [run("A", "us", 30, 80, { decision_ts: "2026-10-13T04:00:00Z" }), run("A", "us", 75, 80, { decision_ts: "2026-10-13T07:00:00Z" }), run("B", "us", 50, 80), run("C", "us", 35, 80)],
      alertWindowStart: "2026-10-13T00:00:00Z", held: new Set(["us:A", "us:B", "us:C"]),
    });
    expect(hits.map((h) => h.symbol)).toEqual(["C", "B"]);
  });
});
