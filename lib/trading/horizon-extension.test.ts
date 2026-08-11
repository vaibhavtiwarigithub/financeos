import { describe, it, expect } from "vitest";
import { decideExtension, SCORE_DECAY_TOLERANCE, type ExtensionInputs } from "@/lib/trading/horizon-extension";

// A position that satisfies every condition. Individual tests break exactly one
// field, so a failure names the condition that broke rather than "something".
const HEALTHY: ExtensionInputs = {
  market: "us",
  ageDays: 10,
  horizonDays: 10,
  ceilingDays: 15,
  score: 72,
  scoreFresh: true,
  priorScore: 70,
  entryThreshold: 60,
  unrealizedPct: 4.2,
  benchmarkRelPct: 1.1,
  priceAboveEma20: true,
  breakdownVeto: false,
  earningsVeto: false,
  dataQualityOk: true,
};

const at = (over: Partial<ExtensionInputs>): ExtensionInputs => ({ ...HEALTHY, ...over });

describe("decideExtension — checkpoint and ceiling", () => {
  it("does nothing before the horizon is reached", () => {
    const v = decideExtension(at({ ageDays: 7 }));
    expect(v.extend).toBe(false);
    expect(v.reason).toBe("not_at_checkpoint");
    // Not a rejection — no condition was even evaluated.
    expect(v.failed).toEqual([]);
  });

  it("refuses at the mandate ceiling no matter how healthy the position is", () => {
    const v = decideExtension(at({ ageDays: 15 }));
    expect(v.extend).toBe(false);
    expect(v.reason).toBe("ceiling_reached");
  });

  it("cannot be pushed past the ceiling by any combination of signals", () => {
    for (const age of [15, 16, 40]) {
      expect(decideExtension(at({ ageDays: age })).extend).toBe(false);
    }
  });

  it("extends by exactly ONE day, never straight to the ceiling", () => {
    const v = decideExtension(at({ ageDays: 10 }));
    expect(v.extend).toBe(true);
    expect(v.effectiveExitDay).toBe(11);
  });

  it("clamps the one-day extension to the ceiling", () => {
    const v = decideExtension(at({ ageDays: 14, ceilingDays: 15 }));
    expect(v.extend).toBe(true);
    expect(v.effectiveExitDay).toBe(15);
  });
});

describe("decideExtension — score conditions", () => {
  it("requires the ENTRY threshold, not the lower exit threshold", () => {
    // 58 would survive a 55 exit threshold but must NOT buy extra holding time.
    const v = decideExtension(at({ score: 58, entryThreshold: 60 }));
    expect(v.extend).toBe(false);
    expect(v.failed).toContain("score_below_entry_threshold");
  });

  it("rejects a stale score even when its value is high", () => {
    const v = decideExtension(at({ score: 90, scoreFresh: false }));
    expect(v.extend).toBe(false);
    expect(v.failed).toContain("score_stale");
  });

  it("rejects a high but deteriorating score", () => {
    const v = decideExtension(at({ score: 72, priorScore: 85 }));
    expect(v.extend).toBe(false);
    expect(v.failed).toContain("score_deteriorating");
  });

  it("tolerates ordinary score noise as stable", () => {
    const v = decideExtension(at({ score: 70 - SCORE_DECAY_TOLERANCE, priorScore: 70 }));
    expect(v.extend).toBe(true);
  });

  it("treats one point beyond tolerance as deterioration", () => {
    const v = decideExtension(at({ score: 70 - SCORE_DECAY_TOLERANCE - 1, priorScore: 70 }));
    expect(v.failed).toContain("score_deteriorating");
  });
});

describe("decideExtension — performance conditions", () => {
  it("will not extend a losing position", () => {
    expect(decideExtension(at({ unrealizedPct: -0.5 })).failed).toContain("unrealized_not_positive");
  });

  it("will not extend a flat position", () => {
    expect(decideExtension(at({ unrealizedPct: 0 })).failed).toContain("unrealized_not_positive");
  });

  it("will not extend a position lagging its benchmark", () => {
    expect(decideExtension(at({ benchmarkRelPct: -0.01 })).failed).toContain("lagging_benchmark");
  });

  it("accepts exactly matching the benchmark", () => {
    expect(decideExtension(at({ benchmarkRelPct: 0 })).extend).toBe(true);
  });
});

describe("decideExtension — trend and vetoes", () => {
  it("requires price above EMA20", () => {
    expect(decideExtension(at({ priceAboveEma20: false })).failed).toContain("trend_unhealthy");
  });
  it("honours the breakdown veto", () => {
    expect(decideExtension(at({ breakdownVeto: true })).failed).toContain("breakdown_veto");
  });
  it("honours the earnings veto", () => {
    expect(decideExtension(at({ earningsVeto: true })).failed).toContain("earnings_veto");
  });
  it("honours the data-quality veto", () => {
    expect(decideExtension(at({ dataQualityOk: false })).failed).toContain("data_quality_veto");
  });
});

describe("decideExtension — fail-closed on missing evidence", () => {
  // The whole point: absent evidence must never buy extra holding time. This
  // mirrors the degradation guard's "no baseline => abstain" rule.
  const required: Array<keyof ExtensionInputs> = [
    "score", "priorScore", "unrealizedPct", "benchmarkRelPct",
    "priceAboveEma20", "breakdownVeto", "earningsVeto", "dataQualityOk",
  ];

  for (const field of required) {
    it(`refuses to extend when ${String(field)} is null`, () => {
      const v = decideExtension(at({ [field]: null } as Partial<ExtensionInputs>));
      expect(v.extend, `${String(field)} null must not extend`).toBe(false);
    });
  }

  it("reports every failing condition, not just the first", () => {
    const v = decideExtension(at({ unrealizedPct: -1, priceAboveEma20: false, breakdownVeto: true }));
    expect(v.failed).toContain("unrealized_not_positive");
    expect(v.failed).toContain("trend_unhealthy");
    expect(v.failed).toContain("breakdown_veto");
  });

  it("never reports duplicate reason codes", () => {
    // Several null inputs all map to evidence_missing.
    const v = decideExtension(at({ unrealizedPct: null, benchmarkRelPct: null, priceAboveEma20: null }));
    expect(new Set(v.failed).size).toBe(v.failed.length);
  });
});

describe("decideExtension — safety invariant", () => {
  it("can only ever produce an exit day inside [horizon, ceiling]", () => {
    // Fuzz the inputs; the decision must never schedule an exit outside the
    // mandate window, which is the one thing that would make it unsafe.
    const vals = [null, 0, 1, -5, 50, 100] as const;
    for (const age of [0, 9, 10, 11, 14, 15, 20]) {
      for (const u of vals) {
        for (const b of vals) {
          const v = decideExtension(at({ ageDays: age, unrealizedPct: u as any, benchmarkRelPct: b as any }));
          expect(v.effectiveExitDay).toBeLessThanOrEqual(HEALTHY.ceilingDays);
          expect(v.effectiveExitDay).toBeGreaterThanOrEqual(Math.min(age, HEALTHY.horizonDays));
        }
      }
    }
  });
});
